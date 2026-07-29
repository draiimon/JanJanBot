const fs = require('fs');
const path = require('path');
const https = require('https');
const { GlobalFonts } = require('@napi-rs/canvas');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

const FONTS = {
  notoReg: { file: 'NotoSans-Regular.ttf', family: 'Noto Sans', url: 'https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf' },
  notoBold: { file: 'NotoSans-Bold.ttf', family: 'Noto Sans Bold', url: 'https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Bold.ttf' },
  orbitron: {
    file: 'Orbitron-Variable.ttf',
    family: 'Orbitron',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/orbitron/Orbitron%5Bwght%5D.ttf',
  },
  rajdhaniMedium: {
    file: 'Rajdhani-Medium.ttf',
    family: 'Rajdhani',
    url: 'https://github.com/google/fonts/raw/main/ofl/rajdhani/Rajdhani-Medium.ttf',
  },
  rajdhaniBold: {
    file: 'Rajdhani-Bold.ttf',
    family: 'Rajdhani Bold',
    url: 'https://github.com/google/fonts/raw/main/ofl/rajdhani/Rajdhani-Bold.ttf',
  },
};

const WIN_SEGOE = 'C:\\Windows\\Fonts\\segoeui.ttf';
const WIN_SEGOE_BOLD = 'C:\\Windows\\Fonts\\segoeuib.ttf';

let fontsReady = null;
let fontFamily = 'Arial';

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`Font download HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', reject);
  });
}

async function ensureFontFile({ file, url }) {
  const dest = path.join(FONT_DIR, file);
  if (!fs.existsSync(dest)) {
    await downloadFile(url, dest).catch((err) => {
      console.warn(`[WELCOME] Font ${file} download failed:`, err.message);
    });
  }
  return dest;
}

async function ensureWelcomeFonts() {
  if (fontsReady) return fontsReady;

  fontsReady = (async () => {
    for (const spec of Object.values(FONTS)) {
      const dest = await ensureFontFile(spec);
      if (fs.existsSync(dest)) {
        GlobalFonts.registerFromPath(dest, spec.family);
      }
    }

    if (fs.existsSync(path.join(FONT_DIR, FONTS.notoReg.file))) {
      fontFamily = 'Noto Sans';
    } else if (process.platform === 'win32' && fs.existsSync(WIN_SEGOE)) {
      GlobalFonts.registerFromPath(WIN_SEGOE, 'Segoe UI');
      if (fs.existsSync(WIN_SEGOE_BOLD)) {
        GlobalFonts.registerFromPath(WIN_SEGOE_BOLD, 'Segoe UI Bold');
      }
      fontFamily = 'Segoe UI';
    }

    return fontFamily;
  })();

  return fontsReady;
}

function getFontFamily() {
  return fontFamily;
}

function getOrbitronFont() {
  return GlobalFonts.has('Orbitron') ? 'Orbitron' : 'sans-serif';
}

function getRajdhaniFont() {
  return GlobalFonts.has('Rajdhani') ? 'Rajdhani' : 'sans-serif';
}

/** Keep Discord guild stylized name — do not strip to ASCII. */
function getServerDisplayName(guildName) {
  const name = String(guildName || '').trim();
  return name || 'ᴘʟᴀʏ ɢʀᴏᴜɴᴅ';
}

module.exports = {
  ensureWelcomeFonts,
  getFontFamily,
  getOrbitronFont,
  getRajdhaniFont,
  getServerDisplayName,
};
