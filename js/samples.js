/**
 * Procedural test images covering the five validation cases:
 * portrait, landscape, low-color composition, highly detailed, high contrast.
 * Generated locally so the app (and its benchmark) works offline.
 */

import { Rng } from './prng.js';

function ellipse( g, x, y, rx, ry, rot = 0 ) {
	g.beginPath();
	g.ellipse( x, y, rx, ry, rot, 0, Math.PI * 2 );
	g.fill();
}

function radial( g, x, y, r, color ) {
	const rg = g.createRadialGradient( x, y, 0, x, y, r );
	rg.addColorStop( 0, color );
	rg.addColorStop( 1, color.replace( /[\d.]+\)$/, '0)' ) );
	g.fillStyle = rg;
	g.fillRect( x - r, y - r, r * 2, r * 2 );
}

function portrait( c ) {
	c.width = 720;
	c.height = 900;
	const g = c.getContext( '2d' );
	let lg = g.createLinearGradient( 0, 0, 720, 900 );
	lg.addColorStop( 0, '#2d5b70' );
	lg.addColorStop( 1, '#9fc0bd' );
	g.fillStyle = lg;
	g.fillRect( 0, 0, 720, 900 );
	radial( g, 590, 170, 330, 'rgba(250,224,176,0.6)' );
	// Hair (back).
	g.fillStyle = '#3a2317';
	ellipse( g, 360, 410, 230, 300 );
	g.fillRect( 130, 410, 460, 260 );
	// Sweater.
	lg = g.createLinearGradient( 0, 640, 720, 900 );
	lg.addColorStop( 0, '#d99a3c' );
	lg.addColorStop( 1, '#9c5d1c' );
	g.fillStyle = lg;
	g.beginPath();
	g.moveTo( 40, 900 );
	g.quadraticCurveTo( 70, 700, 250, 668 );
	g.lineTo( 470, 668 );
	g.quadraticCurveTo( 650, 700, 680, 900 );
	g.closePath();
	g.fill();
	// Neck.
	lg = g.createLinearGradient( 300, 0, 420, 0 );
	lg.addColorStop( 0, '#b77756' );
	lg.addColorStop( 0.6, '#d9a17f' );
	lg.addColorStop( 1, '#c48663' );
	g.fillStyle = lg;
	g.fillRect( 302, 560, 116, 140 );
	g.fillStyle = 'rgba(120,64,40,0.45)';
	ellipse( g, 360, 600, 62, 26 );
	// Collar.
	g.fillStyle = '#efe4cf';
	g.beginPath();
	g.moveTo( 280, 668 );
	g.lineTo( 360, 735 );
	g.lineTo( 440, 668 );
	g.lineTo( 420, 660 );
	g.lineTo( 360, 705 );
	g.lineTo( 300, 660 );
	g.closePath();
	g.fill();
	// Ears.
	g.fillStyle = '#cf9472';
	ellipse( g, 200, 440, 26, 46 );
	ellipse( g, 520, 440, 26, 46 );
	// Face.
	const fg = g.createRadialGradient( 330, 380, 30, 360, 430, 240 );
	fg.addColorStop( 0, '#f4cdac' );
	fg.addColorStop( 0.65, '#dfa583' );
	fg.addColorStop( 1, '#b7795a' );
	g.fillStyle = fg;
	ellipse( g, 360, 425, 165, 215 );
	// Hair (front).
	g.fillStyle = '#3a2317';
	g.beginPath();
	g.moveTo( 190, 420 );
	g.bezierCurveTo( 170, 210, 330, 150, 420, 185 );
	g.bezierCurveTo( 520, 215, 560, 300, 530, 430 );
	g.bezierCurveTo( 500, 330, 430, 280, 330, 300 );
	g.bezierCurveTo( 260, 320, 220, 360, 190, 420 );
	g.fill();
	g.strokeStyle = 'rgba(120,80,50,0.5)';
	g.lineWidth = 3;
	for ( let i = 0; i < 9; i++ ) {
		g.beginPath();
		g.moveTo( 230 + i * 30, 205 + Math.abs( 4 - i ) * 6 );
		g.quadraticCurveTo( 260 + i * 25, 260, 250 + i * 28, 310 );
		g.stroke();
	}
	// Brows.
	g.strokeStyle = '#3b2519';
	g.lineCap = 'round';
	g.lineWidth = 11;
	g.beginPath();
	g.moveTo( 252, 372 );
	g.quadraticCurveTo( 292, 350, 330, 366 );
	g.stroke();
	g.beginPath();
	g.moveTo( 390, 366 );
	g.quadraticCurveTo( 428, 350, 468, 372 );
	g.stroke();
	// Eyes.
	for ( const ex of [ 292, 428 ] ) {
		g.fillStyle = '#f6efe8';
		ellipse( g, ex, 410, 34, 15 );
		g.fillStyle = '#4b6f8f';
		ellipse( g, ex, 410, 14, 14 );
		g.fillStyle = '#141414';
		ellipse( g, ex, 410, 6.5, 6.5 );
		g.fillStyle = '#ffffff';
		ellipse( g, ex + 5, 405, 3, 3 );
		g.strokeStyle = '#2a1a12';
		g.lineWidth = 4;
		g.beginPath();
		g.ellipse( ex, 412, 35, 17, 0, Math.PI * 1.05, Math.PI * 1.95 );
		g.stroke();
	}
	// Nose.
	g.strokeStyle = 'rgba(140,80,55,0.8)';
	g.lineWidth = 5;
	g.beginPath();
	g.moveTo( 368, 420 );
	g.quadraticCurveTo( 382, 470, 372, 492 );
	g.quadraticCurveTo( 360, 500, 345, 492 );
	g.stroke();
	g.fillStyle = 'rgba(120,60,40,0.55)';
	ellipse( g, 343, 492, 9, 5 );
	ellipse( g, 380, 492, 9, 5 );
	// Lips.
	g.fillStyle = '#b4525a';
	ellipse( g, 360, 548, 54, 13 );
	g.fillStyle = '#9a3f48';
	ellipse( g, 360, 540, 48, 9 );
	g.strokeStyle = '#6d2a31';
	g.lineWidth = 3;
	g.beginPath();
	g.moveTo( 308, 545 );
	g.quadraticCurveTo( 360, 552, 412, 545 );
	g.stroke();
	// Cheeks.
	radial( g, 270, 485, 60, 'rgba(226,120,110,0.35)' );
	radial( g, 450, 485, 60, 'rgba(226,120,110,0.35)' );
}

function ridge( g, rng, y0, amp, rough, color, W, H ) {
	g.fillStyle = color;
	g.beginPath();
	g.moveTo( 0, H );
	let y = y0;
	for ( let x = 0; x <= W; x += 8 ) {
		y += ( rng.float() - 0.5 ) * rough + ( y0 - y ) * 0.04 + Math.sin( x / 140 ) * amp * 0.02;
		g.lineTo( x, y - amp * Math.abs( Math.sin( x / 210 + y0 ) ) );
	}
	g.lineTo( W, H );
	g.closePath();
	g.fill();
}

function landscape( c ) {
	const W = ( c.width = 960 );
	const H = ( c.height = 640 );
	const g = c.getContext( '2d' );
	const rng = new Rng( 21 );
	let lg = g.createLinearGradient( 0, 0, 0, 380 );
	lg.addColorStop( 0, '#4f8fd0' );
	lg.addColorStop( 0.7, '#a9cbe6' );
	lg.addColorStop( 1, '#f5d9ad' );
	g.fillStyle = lg;
	g.fillRect( 0, 0, W, H );
	radial( g, 700, 250, 160, 'rgba(255,236,190,0.9)' );
	g.fillStyle = '#fff3d6';
	ellipse( g, 700, 255, 34, 34 );
	for ( let i = 0; i < 9; i++ ) {
		const cx = rng.range( 40, 920 );
		const cy = rng.range( 50, 190 );
		for ( let j = 0; j < 6; j++ ) {
			radial( g, cx + rng.range( -70, 70 ), cy + rng.range( -12, 12 ), rng.range( 30, 60 ), 'rgba(255,255,255,0.55)' );
		}
	}
	ridge( g, rng, 300, 90, 14, '#8c90b8', W, H );
	ridge( g, rng, 345, 60, 12, '#5f6f95', W, H );
	ridge( g, rng, 400, 30, 8, '#4f7b4a', W, H );
	// Lake.
	lg = g.createLinearGradient( 0, 430, 0, 560 );
	lg.addColorStop( 0, '#9ec3df' );
	lg.addColorStop( 1, '#3f6f93' );
	g.fillStyle = lg;
	g.fillRect( 0, 430, W, 130 );
	g.strokeStyle = 'rgba(255,255,255,0.45)';
	g.lineWidth = 2;
	for ( let i = 0; i < 40; i++ ) {
		const x = rng.range( 0, W );
		const y = rng.range( 440, 550 );
		g.beginPath();
		g.moveTo( x, y );
		g.lineTo( x + rng.range( 20, 70 ), y );
		g.stroke();
	}
	radial( g, 700, 470, 60, 'rgba(255,236,190,0.6)' );
	// Pines on the shore.
	for ( let i = 0; i < 34; i++ ) {
		const x = rng.range( 0, W );
		const h = rng.range( 50, 120 );
		const base = 432 + rng.range( -6, 6 );
		g.fillStyle = rng.float() < 0.5 ? '#1f3d28' : '#2a4d30';
		for ( let t = 0; t < 3; t++ ) {
			g.beginPath();
			g.moveTo( x, base - h + t * h * 0.22 );
			g.lineTo( x - h * ( 0.18 + t * 0.06 ), base - h * 0.35 + t * h * 0.2 );
			g.lineTo( x + h * ( 0.18 + t * 0.06 ), base - h * 0.35 + t * h * 0.2 );
			g.closePath();
			g.fill();
		}
	}
	// Foreground meadow.
	lg = g.createLinearGradient( 0, 550, 0, H );
	lg.addColorStop( 0, '#6b8f3a' );
	lg.addColorStop( 1, '#3f5f22' );
	g.fillStyle = lg;
	g.beginPath();
	g.moveTo( 0, 560 );
	g.quadraticCurveTo( 480, 535, W, 565 );
	g.lineTo( W, H );
	g.lineTo( 0, H );
	g.fill();
	for ( let i = 0; i < 90; i++ ) {
		g.fillStyle = [ '#f2d24b', '#f6f2e8', '#d9534f' ][ rng.int( 3 ) ];
		ellipse( g, rng.range( 0, W ), rng.range( 575, H ), 3, 3 );
	}
}

function lowColor( c ) {
	c.width = 800;
	c.height = 800;
	const g = c.getContext( '2d' );
	g.fillStyle = '#efe0c2';
	g.fillRect( 0, 0, 800, 800 );
	g.fillStyle = '#1f3a64';
	g.fillRect( 90, 430, 420, 280 );
	g.fillStyle = '#d23a2c';
	ellipse( g, 520, 330, 190, 190 );
	g.fillStyle = '#e8b33a';
	g.beginPath();
	g.arc( 250, 430, 150, Math.PI, 0 );
	g.fill();
	g.fillStyle = '#1f3a64';
	g.fillRect( 600, 560, 120, 150 );
	g.fillStyle = '#d23a2c';
	g.fillRect( 600, 90, 40, 140 );
}

function detailed( c ) {
	const W = ( c.width = 900 );
	const H = ( c.height = 700 );
	const g = c.getContext( '2d' );
	const rng = new Rng( 5 );
	let lg = g.createLinearGradient( 0, 0, 0, 330 );
	lg.addColorStop( 0, '#f1a35f' );
	lg.addColorStop( 1, '#f7e2b8' );
	g.fillStyle = lg;
	g.fillRect( 0, 0, W, H );
	// Skyline with lit windows.
	let x = 0;
	while ( x < W ) {
		const bw = rng.range( 40, 95 );
		const bh = rng.range( 120, 300 );
		const shade = rng.int( 3 );
		g.fillStyle = [ '#3d3550', '#4b4361', '#2e2a40' ][ shade ];
		g.fillRect( x, 340 - bh, bw - 4, bh );
		for ( let wy = 340 - bh + 10; wy < 330; wy += 14 ) {
			for ( let wx = x + 6; wx < x + bw - 12; wx += 11 ) {
				g.fillStyle = rng.float() < 0.45 ? '#ffd27a' : '#5b5375';
				g.fillRect( wx, wy, 6, 8 );
			}
		}
		x += bw;
	}
	// Dense flower field.
	g.fillStyle = '#3e6b2f';
	g.fillRect( 0, 340, W, H - 340 );
	const colors = [ '#e4572e', '#f3a712', '#a8c686', '#669bbc', '#ffffff', '#c03a8f', '#f7d1e3' ];
	for ( let i = 0; i < 1500; i++ ) {
		const fy = rng.range( 345, H );
		const fx = rng.range( 0, W );
		const s = 2 + ( ( fy - 340 ) / ( H - 340 ) ) * 7;
		g.strokeStyle = '#2b4a22';
		g.lineWidth = 1;
		g.beginPath();
		g.moveTo( fx, fy );
		g.lineTo( fx + rng.range( -2, 2 ), fy + s * 2 );
		g.stroke();
		g.fillStyle = colors[ rng.int( colors.length ) ];
		for ( let p = 0; p < 5; p++ ) {
			const a = ( p / 5 ) * Math.PI * 2;
			ellipse( g, fx + Math.cos( a ) * s * 0.6, fy + Math.sin( a ) * s * 0.6, s * 0.5, s * 0.5 );
		}
		g.fillStyle = '#f9e45b';
		ellipse( g, fx, fy, s * 0.3, s * 0.3 );
	}
}

function highContrast( c ) {
	const W = ( c.width = 900 );
	const H = ( c.height = 600 );
	const g = c.getContext( '2d' );
	const rng = new Rng( 9 );
	const lg = g.createLinearGradient( 0, 0, 0, H );
	lg.addColorStop( 0, '#b8341b' );
	lg.addColorStop( 0.55, '#f08a24' );
	lg.addColorStop( 0.8, '#ffd76b' );
	g.fillStyle = lg;
	g.fillRect( 0, 0, W, H );
	g.fillStyle = '#fff8e3';
	ellipse( g, 610, 300, 110, 110 );
	g.fillStyle = '#0b0b0d';
	g.beginPath();
	g.moveTo( 0, H );
	g.lineTo( 0, 470 );
	g.quadraticCurveTo( 300, 430, 520, 480 );
	g.quadraticCurveTo( 760, 520, W, 470 );
	g.lineTo( W, H );
	g.fill();
	g.strokeStyle = '#0b0b0d';
	g.lineCap = 'round';
	const branch = ( x, y, len, ang, w, depth ) => {
		const x2 = x + Math.cos( ang ) * len;
		const y2 = y + Math.sin( ang ) * len;
		g.lineWidth = w;
		g.beginPath();
		g.moveTo( x, y );
		g.lineTo( x2, y2 );
		g.stroke();
		if ( depth > 0 ) {
			branch( x2, y2, len * rng.range( 0.65, 0.8 ), ang - rng.range( 0.25, 0.6 ), w * 0.68, depth - 1 );
			branch( x2, y2, len * rng.range( 0.65, 0.8 ), ang + rng.range( 0.25, 0.6 ), w * 0.68, depth - 1 );
		}
	};
	branch( 260, 470, 120, -Math.PI / 2 - 0.08, 26, 8 );
	for ( let i = 0; i < 7; i++ ) {
		const bx = rng.range( 450, 820 );
		const by = rng.range( 80, 220 );
		g.lineWidth = 4;
		g.beginPath();
		g.moveTo( bx - 14, by - 6 );
		g.quadraticCurveTo( bx - 6, by - 10, bx, by );
		g.quadraticCurveTo( bx + 6, by - 10, bx + 14, by - 6 );
		g.stroke();
	}
}

function lettering( c ) {
	const W = ( c.width = 900 );
	const H = ( c.height = 900 );
	const g = c.getContext( '2d' );
	g.fillStyle = '#ffffff';
	g.fillRect( 0, 0, W, H );
	// A blue disc label with a white band, lettering and a simple mark.
	g.fillStyle = '#1f6fb8';
	ellipse( g, 450, 450, 420, 420 );
	g.fillStyle = '#f2f4f7';
	g.save();
	g.beginPath();
	g.arc( 450, 450, 420, 0, Math.PI * 2 );
	g.clip();
	g.fillRect( 0, 0, W, 250 );
	g.restore();
	g.fillStyle = '#ffffff';
	ellipse( g, 450, 450, 95, 95 );
	g.fillStyle = '#dfe3e8';
	ellipse( g, 450, 450, 45, 45 );
	g.fillStyle = '#111111';
	g.font = '600 74px Helvetica, Arial, sans-serif';
	g.textAlign = 'center';
	g.fillText( 'AQUARELLE', 450, 190 );
	g.fillStyle = '#ffffff';
	g.textAlign = 'left';
	g.font = '700 64px Helvetica, Arial, sans-serif';
	g.fillText( 'Watercolor', 90, 410 );
	g.font = '400 40px Helvetica, Arial, sans-serif';
	g.fillText( 'Paint something', 92, 470 );
	g.font = '400 30px Helvetica, Arial, sans-serif';
	g.fillText( 'Drops · Splashes · Brushes', 150, 620 );
	g.fillText( 'Version 1.0', 360, 760 );
	// A simple circular mark.
	g.strokeStyle = '#ffffff';
	g.lineWidth = 16;
	g.beginPath();
	g.arc( 690, 450, 105, 0, Math.PI * 2 );
	g.stroke();
	g.lineWidth = 22;
	g.beginPath();
	g.moveTo( 640, 395 );
	g.lineTo( 668, 505 );
	g.lineTo( 690, 440 );
	g.lineTo( 712, 505 );
	g.lineTo( 740, 395 );
	g.stroke();
}

export const SAMPLES = {
	portrait: { label: 'Portrait', draw: portrait },
	landscape: { label: 'Landscape', draw: landscape },
	lowcolor: { label: 'Low-color', draw: lowColor },
	detailed: { label: 'Detailed', draw: detailed },
	contrast: { label: 'High-contrast', draw: highContrast },
	lettering: { label: 'Lettering', draw: lettering },
};

export function makeSample( name ) {
	const c = document.createElement( 'canvas' );
	SAMPLES[ name ].draw( c );
	return c;
}
