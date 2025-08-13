const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function renderPdfFromHtml(html) {
    const outDir = process.env.TEMP_UPLOAD_PATH || os.tmpdir();
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, `audit-${Date.now()}.pdf`);

    const browser = await puppeteer.launch({
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--font-render-hinting=medium',
        ],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.emulateMediaType('screen');
    await page.pdf({
        path: outPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
    });
    await browser.close();
    return outPath;
}

module.exports = { renderPdfFromHtml };
