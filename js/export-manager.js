/**
 * ExportManager — PNG export at a multiple of the simulation resolution
 * (rendered off-screen by the GPU, so it is genuinely higher resolution),
 * and optional WebM recording via MediaRecorder.
 */

function download( blob, filename ) {
	const url = URL.createObjectURL( blob );
	const a = document.createElement( 'a' );
	a.href = url;
	a.download = filename;
	document.body.appendChild( a );
	a.click();
	a.remove();
	setTimeout( () => URL.revokeObjectURL( url ), 5000 );
}

export class ExportManager {
	constructor( renderer ) {
		this.renderer = renderer;
		this.recorder = null;
	}

	async exportPNG( scale, filename ) {
		const r = this.renderer;
		const maxSize = r.gl.getParameter( r.gl.MAX_TEXTURE_SIZE );
		const s = Math.min( scale, Math.floor( maxSize / Math.max( r.W, r.H ) ) );
		const w = r.W * s;
		const h = r.H * s;
		const px = r.renderToPixels( w, h );
		const c = document.createElement( 'canvas' );
		c.width = w;
		c.height = h;
		c.getContext( '2d' ).putImageData( new ImageData( new Uint8ClampedArray( px.buffer ), w, h ), 0, 0 );
		const blob = await new Promise( ( res ) => c.toBlob( res, 'image/png' ) );
		download( blob, filename );
		return { w, h, bytes: blob.size };
	}

	canRecord() {
		return 'undefined' !== typeof MediaRecorder && !! HTMLCanvasElement.prototype.captureStream;
	}

	startRecording( canvas ) {
		const types = [ 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4' ];
		const mimeType = types.find( ( t ) => MediaRecorder.isTypeSupported( t ) ) || '';
		const stream = canvas.captureStream( 30 );
		this.chunks = [];
		this.recorder = new MediaRecorder( stream, mimeType ? { mimeType, videoBitsPerSecond: 8e6 } : undefined );
		this.recorder.ondataavailable = ( e ) => e.data.size && this.chunks.push( e.data );
		this.recorder.start( 1000 );
		this.mime = this.recorder.mimeType || mimeType || 'video/webm';
	}

	stopRecording( filename ) {
		return new Promise( ( res ) => {
			if ( ! this.recorder ) {
				res( null );
				return;
			}
			this.recorder.onstop = () => {
				const blob = new Blob( this.chunks, { type: this.mime } );
				download( blob, filename + ( this.mime.includes( 'mp4' ) ? '.mp4' : '.webm' ) );
				this.recorder = null;
				res( blob );
			};
			this.recorder.stop();
		} );
	}
}
