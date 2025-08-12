const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

async function renderPdfFromHtml(html) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const outDir = path.join(process.cwd(), 'tmp');
  ensureDir(outDir);

  const outPath = path.join(outDir, `audit-${Date.now()}.pdf`);
  await page.pdf({ path: outPath, format: 'A4', printBackground: true });
  await browser.close();
  return outPath;
}

module.exports = { renderPdfFromHtml };
