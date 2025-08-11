const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function renderPdfFromHtml(html) {
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const outPath = path.join(process.cwd(), 'tmp', `audit-${Date.now()}.pdf`);
    await page.pdf({ path: outPath, format: 'A4', printBackground: true });
    await browser.close();
    return outPath;
}

module.exports = { renderPdfFromHtml };
