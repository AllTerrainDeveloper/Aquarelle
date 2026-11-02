/**
 * WatercolorRenderer — WebGL2.
 *
 * The CPU simulation produces a low-resolution optical-density field
 * (RGB density + water). The GPU upsamples it to display/export resolution
 * and composes the watercolor look per pixel:
 *  - Beer–Lambert glazing over the paper colour
 *  - edge warping with paper noise (organic, crisp-looking wash borders
 *    at resolutions far above the simulation grid)
 *  - granulation: pigment settles in paper valleys
 *  - pigment mottling, paper relief lighting, wet sheen
 * Only dirty rows of the density texture are uploaded each frame.
 */

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
	vUv = vec2( aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5 );
	gl_Position = vec4( aPos, 0.0, 1.0 );
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uDens;
uniform sampler2D uPaper;
uniform sampler2D uErr;
uniform vec2 uSim;
uniform vec2 uPaperScale;
uniform vec3 uPaperColor;
uniform float uGran;
uniform float uGranFull;
uniform float uWarp;
uniform float uTexel;
uniform int uView;
uniform float uSheen;
uniform vec4 uCam;
uniform float uFine;
// The sheet's look: paper relief lighting, fibres and uneven sizing, pigment
// pooling at wash edges, mottling.
uniform vec4 uLook;
uniform int uSharp;
in vec2 vUv;
out vec4 outColor;

vec4 dens( vec2 uv ) {
	vec2 p = uv * uSim - 0.5;
	if ( uSharp > 0 ) {
		// Catmull-Rom between cells: as smooth as the blend below, but it keeps
		// a cell's own value at its centre instead of averaging it away with
		// its neighbours, so fine detail (a lit window, a strand) stays crisp.
		vec2 i0 = floor( p );
		vec2 f = p - i0;
		vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );
		vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );
		vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );
		vec2 w3 = f * f * ( -0.5 + 0.5 * f );
		ivec2 hi = ivec2( uSim ) - 1;
		vec4 acc = vec4( 0.0 );
		for ( int dy = 0; dy < 4; dy++ ) {
			float wy = dy == 0 ? w0.y : dy == 1 ? w1.y : dy == 2 ? w2.y : w3.y;
			for ( int dx = 0; dx < 4; dx++ ) {
				float wx = dx == 0 ? w0.x : dx == 1 ? w1.x : dx == 2 ? w2.x : w3.x;
				ivec2 c = clamp( ivec2( i0 ) + ivec2( dx - 1, dy - 1 ), ivec2( 0 ), hi );
				acc += texelFetch( uDens, c, 0 ) * ( wx * wy );
			}
		}
		return max( acc, 0.0 );
	}
	vec2 f = fract( p );
	// Smooth (C1) blending between cells: no visible grid when seen up close.
	// The GPU's own bilinear filter does the blend in one lookup, at the
	// smoothed position between the four cells.
	f = f * f * ( 3.0 - 2.0 * f );
	return texture( uDens, ( floor( p ) + 0.5 + f ) / uSim );
}

vec3 toSrgb( vec3 c ) {
	return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
}

vec3 heat( float e ) {
	return clamp( vec3( 1.5 * e, 1.5 * e - 0.5, 0.2 - e ), 0.0, 1.0 );
}

void main() {
	// The camera: which part of the sheet this pixel shows (Cinematic).
	vec2 sv = uCam.xy + vUv * uCam.zw;
	if ( any( lessThan( sv, vec2( 0.0 ) ) ) || any( greaterThan( sv, vec2( 1.0 ) ) ) ) {
		// The desk around the sheet (the overlay draws it over this).
		outColor = vec4( 0.847, 0.82, 0.769, 1.0 );
		return;
	}
	vec2 puv = sv * uPaperScale;
	vec4 pp = texture( uPaper, puv );
	float ph = pp.r;
	// Organic edges: warp the lookup with low and high frequency paper noise.
	vec2 warpLo = ( texture( uPaper, puv * 0.23 + 0.31 ).gb - 0.5 ) * uWarp;
	vec2 warpHi = vec2( texture( uPaper, puv * 1.7 ).a, texture( uPaper, puv * 1.7 + 0.5 ).a ) - 0.5;
	vec2 uv = sv + ( warpLo + warpHi * 0.9 ) / uSim;
	vec4 d = dens( uv );
	vec3 D = max( d.rgb, 0.0 );
	// Pigment pooling along density fronts (subtle; the simulation does the rest):
	// where a wash ends, a step large for the paint there, not the grain within
	// a dark wash, which would darken the whole of it past what was laid.
	vec2 e = 1.0 / uSim;
	vec3 gx = dens( uv + vec2( e.x, 0.0 ) ).rgb - dens( uv - vec2( e.x, 0.0 ) ).rgb;
	vec3 gy = dens( uv + vec2( 0.0, e.y ) ).rgb - dens( uv - vec2( 0.0, e.y ) ).rgb;
	float front = length( abs( gx ) + abs( gy ) ) / ( dot( D, vec3( 0.3333 ) ) + 0.05 );
	D *= 1.0 + uLook.z * smoothstep( 0.6, 1.4, front );
	float w = d.a;
	float dm = dot( D, vec3( 0.3333 ) );
	// Granulation + mottling. Pigment settles in the paper's valleys: plain in
	// light and mid washes, but a heavy dark fills the valleys and the peaks
	// alike, so past uGranFull its speckle stays the same in density (fades
	// in proportion) instead of growing with the paint.
	float g = 1.0 + uGran * ( 0.5 - ph ) * 2.0 * smoothstep( 0.02, 0.6, dm ) * min( 1.0, uGranFull / max( dm, 1e-3 ) );
	g *= 1.0 + uLook.w * ( pp.a - 0.5 ) * smoothstep( 0.0, 0.5, dm );
	// Cold-press sheet: uneven sizing, scattered fibres, warm off-white.
	float sizing = texture( uPaper, sv * uPaperScale * 0.11 + 0.17 ).g - 0.5;
	float fibre = smoothstep( 0.62, 0.8, texture( uPaper, puv * 2.3 + 0.41 ).a ) * smoothstep( 0.55, 0.75, texture( uPaper, puv * 0.9 ).b );
	vec3 paper = uPaperColor * ( 1.0 + uLook.y * ( 0.035 * sizing ) ) - uLook.y * vec3( 0.025, 0.03, 0.04 ) * fibre;
	vec3 col = paper * exp( -D * g );
	// Paper tooth lit from the upper left: highlights on the bumps, shade in the valleys.
	float hx = texture( uPaper, puv + vec2( uTexel, 0.0 ) ).r - texture( uPaper, puv - vec2( uTexel, 0.0 ) ).r;
	float hy = texture( uPaper, puv + vec2( 0.0, uTexel ) ).r - texture( uPaper, puv - vec2( 0.0, uTexel ) ).r;
	float hx2 = texture( uPaper, puv * 0.5 + vec2( uTexel, 0.0 ) ).r - texture( uPaper, puv * 0.5 - vec2( uTexel, 0.0 ) ).r;
	float hy2 = texture( uPaper, puv * 0.5 + vec2( 0.0, uTexel ) ).r - texture( uPaper, puv * 0.5 - vec2( 0.0, uTexel ) ).r;
	float relief = 0.2 * ( hx + hy ) + 0.12 * ( hx2 + hy2 );
	col *= 1.0 + uLook.x * ( relief + 0.06 * ( ph - 0.5 ) );
	// Up close (Cinematic) the sheet shows a finer tooth too.
	if ( uFine > 0.0 ) {
		vec2 fuv = puv * 3.7 + 0.29;
		float fx = texture( uPaper, fuv + vec2( uTexel, 0.0 ) ).r - texture( uPaper, fuv - vec2( uTexel, 0.0 ) ).r;
		float fy = texture( uPaper, fuv + vec2( 0.0, uTexel ) ).r - texture( uPaper, fuv - vec2( 0.0, uTexel ) ).r;
		col *= 1.0 + uFine * ( 0.09 * ( fx + fy ) + 0.025 * ( texture( uPaper, fuv ).r - 0.5 ) );
	}
	// The sheet catches a little less light toward its edges.
	vec2 edgeD = min( sv, 1.0 - sv );
	col *= 0.97 + 0.03 * smoothstep( 0.0, 0.06, min( edgeD.x, edgeD.y ) );
	// Wet paint reads darker and glossier.
	float wet = smoothstep( 0.01, 0.45, w );
	col *= 1.0 - 0.08 * uSheen * wet;
	col += wet * 0.06 * uSheen * max( 0.0, hx + hy );
	// Up close (Cinematic) a wet wash is a film of water: it catches the light
	// as a soft glare that drifts with the paper's tooth.
	col += wet * max( 0.0, uSheen - 1.0 ) * ( 0.025 + 0.05 * smoothstep( 0.0, 0.6, hx2 + hy2 + 0.5 * ( hx + hy ) ) );
	if ( uView == 1 ) {
		col = mix( col, vec3( 0.15, 0.4, 0.95 ), wet * 0.75 );
	} else if ( uView == 2 ) {
		float e = texture( uErr, sv ).r;
		col = mix( col * 0.6 + 0.2, heat( e ), 0.7 );
	}
	outColor = vec4( toSrgb( clamp( col, 0.0, 1.0 ) ), 1.0 );
}`;

/**
 * The sheet's look: pigment settling in the paper's valleys (granulation,
 * density ×(1 ± this), up to the mean density granulationFull, then the
 * same in absolute terms), wash borders warped by the paper (cells), the
 * paper's relief lighting and its fibres and uneven sizing (factors on
 * their usual strength), pigment pooling where a wash ends (density ×(1 +
 * this)) and mottling (×(1 ± this)), and whether cells are blended with
 * Catmull-Rom (sharp) or a smoothed bilinear.
 */
export const LOOK = { granulation: 0.22, granulationFull: 0.5, warp: 0.6, relief: 1, paper: 1, pooling: 0.08, mottling: 0.06, sharp: true };

function compile( gl, type, src ) {
	const s = gl.createShader( type );
	gl.shaderSource( s, src );
	gl.compileShader( s );
	if ( ! gl.getShaderParameter( s, gl.COMPILE_STATUS ) ) {
		throw new Error( gl.getShaderInfoLog( s ) );
	}
	return s;
}

export class WatercolorRenderer {
	constructor( canvas ) {
		this.canvas = canvas;
		const gl = canvas.getContext( 'webgl2', { antialias: false, alpha: false, premultipliedAlpha: false } );
		if ( ! gl ) {
			throw new Error( 'WebGL2 is not available in this browser.' );
		}
		this.gl = gl;
		const prog = gl.createProgram();
		gl.attachShader( prog, compile( gl, gl.VERTEX_SHADER, VS ) );
		gl.attachShader( prog, compile( gl, gl.FRAGMENT_SHADER, FS ) );
		gl.linkProgram( prog );
		if ( ! gl.getProgramParameter( prog, gl.LINK_STATUS ) ) {
			throw new Error( gl.getProgramInfoLog( prog ) );
		}
		this.prog = prog;
		this.u = {};
		for ( const name of [ 'uDens', 'uPaper', 'uErr', 'uSim', 'uPaperScale', 'uPaperColor', 'uGran', 'uWarp', 'uTexel', 'uView', 'uSheen', 'uCam', 'uFine', 'uLook', 'uGranFull', 'uSharp' ] ) {
			this.u[ name ] = gl.getUniformLocation( prog, name );
		}
		this.vao = gl.createVertexArray();
		gl.bindVertexArray( this.vao );
		const buf = gl.createBuffer();
		gl.bindBuffer( gl.ARRAY_BUFFER, buf );
		gl.bufferData( gl.ARRAY_BUFFER, new Float32Array( [ -1, -1, 3, -1, -1, 3 ] ), gl.STATIC_DRAW );
		const loc = gl.getAttribLocation( prog, 'aPos' );
		gl.enableVertexAttribArray( loc );
		gl.vertexAttribPointer( loc, 2, gl.FLOAT, false, 0, 0 );
		this.densTex = null;
		this.errTex = null;
		this.paperTex = null;
		this.view = 0;
		// How glossy wet paint looks (1: as usual; Cinematic shows it more).
		this.sheen = 1;
		// The part of the sheet the canvas shows: origin and size in sheet
		// units (the whole sheet by default; Cinematic's camera moves it).
		this.cam = [ 0, 0, 1, 1 ];
		// Extra fine paper grain when the camera is close (0–1).
		this.fine = 0;
		// The look of the sheet and the paint on it (see LOOK).
		this.look = { ...LOOK };
		this.needsDraw = true;
		this.paperColor = [ 1, 1, 1 ];
	}

	setPaper( tex, size, paperColorLinear ) {
		const gl = this.gl;
		this.paperSize = size;
		this.paperColor = paperColorLinear;
		this.paperTex = gl.createTexture();
		gl.bindTexture( gl.TEXTURE_2D, this.paperTex );
		gl.texImage2D( gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, tex );
		gl.generateMipmap( gl.TEXTURE_2D );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT );
		this.needsDraw = true;
	}

	setup( W, H ) {
		const gl = this.gl;
		this.W = W;
		this.H = H;
		if ( this.densTex ) {
			gl.deleteTexture( this.densTex );
		}
		this.densTex = gl.createTexture();
		gl.bindTexture( gl.TEXTURE_2D, this.densTex );
		// Half floats: filterable on every WebGL2 GPU, and half the bandwidth.
		gl.texImage2D( gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.FLOAT, new Float32Array( W * H * 4 ) );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE );
		// Uploading floats into half floats has the browser convert every value
		// (about 5x the cost of the upload itself). Where the GPU can, the field
		// goes up as it is into a full-float staging texture, and the GPU copies
		// the changed parts across, converting as it goes.
		this._setupStaging( W, H );
		if ( this.errTex ) {
			gl.deleteTexture( this.errTex );
		}
		this.errTex = gl.createTexture();
		gl.bindTexture( gl.TEXTURE_2D, this.errTex );
		gl.pixelStorei( gl.UNPACK_ALIGNMENT, 1 );
		gl.texImage2D( gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array( 1 ) );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE );
		this.needsDraw = true;
	}

	_setupStaging( W, H ) {
		const gl = this.gl;
		if ( this.stage ) {
			gl.deleteTexture( this.stage.tex );
			gl.deleteFramebuffer( this.stage.read );
			gl.deleteFramebuffer( this.stage.draw );
			this.stage = null;
		}
		if ( false === this.canStage || ! gl.getExtension( 'EXT_color_buffer_float' ) ) {
			this.canStage = false;
			return;
		}
		const tex = gl.createTexture();
		gl.bindTexture( gl.TEXTURE_2D, tex );
		gl.texImage2D( gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, null );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST );
		gl.texParameteri( gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST );
		const read = gl.createFramebuffer();
		gl.bindFramebuffer( gl.READ_FRAMEBUFFER, read );
		gl.framebufferTexture2D( gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0 );
		const draw = gl.createFramebuffer();
		gl.bindFramebuffer( gl.DRAW_FRAMEBUFFER, draw );
		gl.framebufferTexture2D( gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.densTex, 0 );
		const ok = gl.checkFramebufferStatus( gl.READ_FRAMEBUFFER ) === gl.FRAMEBUFFER_COMPLETE && gl.checkFramebufferStatus( gl.DRAW_FRAMEBUFFER ) === gl.FRAMEBUFFER_COMPLETE;
		gl.bindFramebuffer( gl.FRAMEBUFFER, null );
		if ( ! ok ) {
			gl.deleteTexture( tex );
			gl.deleteFramebuffer( read );
			gl.deleteFramebuffer( draw );
			this.canStage = false;
			return;
		}
		this.stage = { tex, read, draw };
	}

	/** Uploads only the parts of the density field that changed (cells uploaded). */
	upload( model ) {
		const rects = model.consumeDirtyRects();
		if ( ! rects.length ) {
			return 0;
		}
		const gl = this.gl;
		const st = this.stage;
		gl.bindTexture( gl.TEXTURE_2D, st ? st.tex : this.densTex );
		// Each rectangle is read straight out of the full-width field.
		gl.pixelStorei( gl.UNPACK_ROW_LENGTH, this.W );
		let n = 0;
		for ( const r of rects ) {
			gl.texSubImage2D( gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.FLOAT, model.comp, ( r.y * this.W + r.x ) * 4 );
			n += r.w * r.h;
		}
		gl.pixelStorei( gl.UNPACK_ROW_LENGTH, 0 );
		if ( st ) {
			gl.bindFramebuffer( gl.READ_FRAMEBUFFER, st.read );
			gl.bindFramebuffer( gl.DRAW_FRAMEBUFFER, st.draw );
			for ( const r of rects ) {
				gl.blitFramebuffer( r.x, r.y, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y + r.h, gl.COLOR_BUFFER_BIT, gl.NEAREST );
			}
			gl.bindFramebuffer( gl.FRAMEBUFFER, null );
		}
		this.needsDraw = true;
		return n;
	}

	uploadError( u8, w, h ) {
		const gl = this.gl;
		gl.bindTexture( gl.TEXTURE_2D, this.errTex );
		gl.pixelStorei( gl.UNPACK_ALIGNMENT, 1 );
		gl.texImage2D( gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, u8 );
		if ( 2 === this.view ) {
			this.needsDraw = true;
		}
	}

	resize( pxW, pxH ) {
		if ( this.canvas.width !== pxW || this.canvas.height !== pxH ) {
			this.canvas.width = pxW;
			this.canvas.height = pxH;
			this.needsDraw = true;
		}
	}

	setView( v ) {
		this.view = v;
		this.needsDraw = true;
	}

	setCamera( x, y, w, h, fine = 0 ) {
		const c = this.cam;
		// A camera at rest costs nothing.
		if ( c[ 0 ] === x && c[ 1 ] === y && c[ 2 ] === w && c[ 3 ] === h && this.fine === fine ) {
			return;
		}
		this.cam = [ x, y, w, h ];
		this.fine = fine;
		this.needsDraw = true;
	}

	setSheen( v ) {
		this.sheen = v;
		this.needsDraw = true;
	}

	_draw( w, h, view, cam = this.cam ) {
		const gl = this.gl;
		gl.viewport( 0, 0, w, h );
		gl.useProgram( this.prog );
		gl.bindVertexArray( this.vao );
		gl.activeTexture( gl.TEXTURE0 );
		gl.bindTexture( gl.TEXTURE_2D, this.densTex );
		gl.uniform1i( this.u.uDens, 0 );
		gl.activeTexture( gl.TEXTURE1 );
		gl.bindTexture( gl.TEXTURE_2D, this.paperTex );
		gl.uniform1i( this.u.uPaper, 1 );
		gl.activeTexture( gl.TEXTURE2 );
		gl.bindTexture( gl.TEXTURE_2D, this.errTex );
		gl.uniform1i( this.u.uErr, 2 );
		gl.uniform2f( this.u.uSim, this.W, this.H );
		// Paper grain is tied to the artwork (≈1.5 tiles across the long side)
		// so the same sheet appears at every output resolution.
		const B = Math.max( this.W, this.H );
		gl.uniform2f( this.u.uPaperScale, ( 1.5 * this.W ) / B, ( 1.5 * this.H ) / B );
		gl.uniform3fv( this.u.uPaperColor, this.paperColor );
		const L = this.look;
		gl.uniform1f( this.u.uGran, L.granulation );
		gl.uniform1f( this.u.uGranFull, L.granulationFull );
		gl.uniform1i( this.u.uSharp, L.sharp ? 1 : 0 );
		gl.uniform1f( this.u.uWarp, L.warp );
		gl.uniform4f( this.u.uLook, L.relief, L.paper, L.pooling, L.mottling );
		gl.uniform1f( this.u.uTexel, 1.2 / this.paperSize );
		gl.uniform1i( this.u.uView, view );
		gl.uniform1f( this.u.uSheen, this.sheen );
		gl.uniform4fv( this.u.uCam, cam );
		gl.uniform1f( this.u.uFine, cam === this.cam ? this.fine : 0 );
		gl.drawArrays( gl.TRIANGLES, 0, 3 );
	}

	draw() {
		if ( ! this.densTex || ! this.paperTex ) {
			return false;
		}
		this._draw( this.canvas.width, this.canvas.height, this.view );
		this.needsDraw = false;
		return true;
	}

	/** Renders the artwork off-screen at any resolution (export / final eval). */
	renderToPixels( w, h ) {
		const gl = this.gl;
		const tex = gl.createTexture();
		gl.bindTexture( gl.TEXTURE_2D, tex );
		gl.texImage2D( gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null );
		const fb = gl.createFramebuffer();
		gl.bindFramebuffer( gl.FRAMEBUFFER, fb );
		gl.framebufferTexture2D( gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0 );
		this._draw( w, h, 0, [ 0, 0, 1, 1 ] );
		const px = new Uint8Array( w * h * 4 );
		gl.readPixels( 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px );
		gl.bindFramebuffer( gl.FRAMEBUFFER, null );
		gl.deleteFramebuffer( fb );
		gl.deleteTexture( tex );
		// readPixels is bottom-up; flip to top-down rows.
		const out = new Uint8Array( w * h * 4 );
		const stride = w * 4;
		for ( let y = 0; y < h; y++ ) {
			out.set( px.subarray( ( h - 1 - y ) * stride, ( h - y ) * stride ), y * stride );
		}
		this.needsDraw = true;
		return out;
	}
}
