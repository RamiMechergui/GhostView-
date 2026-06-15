const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname);

async function main() {
  const sizes = [16, 32, 48, 64, 128, 256];
  const shields = [];

  // Shield SVG
  const svg = `<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="s" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e"/>
      <stop offset="100%" style="stop-color:#0f3460"/>
    </linearGradient>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#63b3ed"/>
      <stop offset="100%" style="stop-color:#4299e1"/>
    </linearGradient>
  </defs>
  <!-- Shield -->
  <path d="M128 16 L240 56 L240 116 C240 182 185 226 128 246 C71 226 16 182 16 116 L16 56 Z" fill="url(#s)" stroke="url(#g)" stroke-width="8"/>
  <!-- Inner glow -->
  <path d="M128 32 L220 66 L220 112 C220 170 172 208 128 224 C84 208 36 170 36 112 L36 66 Z" fill="none" stroke="rgba(99,179,237,0.15)" stroke-width="2"/>
  <!-- Letter A -->
  <path d="M128 72 L90 180 L108 180 L114 158 L142 158 L148 180 L166 180 Z" fill="url(#g)"/>
  <!-- A crossbar -->
  <rect x="118" y="136" width="20" height="6" rx="2" fill="#1a1a2e" opacity="0.8"/>
  <!-- Small dots for style -->
  <circle cx="96" cy="96" r="3" fill="rgba(99,179,237,0.3)"/>
  <circle cx="160" cy="96" r="3" fill="rgba(99,179,237,0.3)"/>
</svg>`;

  const png256 = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
  await fs.promises.writeFile(path.join(OUT, 'logo.png'), png256);

  for (const s of sizes) {
    const buf = await sharp(Buffer.from(svg)).resize(s, s).png().toBuffer();
    shields.push(buf);
  }

  const ico = await pngToIco(shields);
  await fs.promises.writeFile(path.join(OUT, 'logo.ico'), ico);
  console.log('Created logo.png and logo.ico');
}

main().catch(e => { console.error(e); process.exit(1); });
