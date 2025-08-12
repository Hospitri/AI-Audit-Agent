const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function renderPdfFromHtml(html) {
    try {
        const tmpDir = path.join(process.cwd(), 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });

        const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        const outPath = path.join(tmpDir, `audit-${Date.now()}.pdf`);
        await page.pdf({ path: outPath, format: 'A4', printBackground: true });

        await page.close();
        await browser.close();

        return outPath;
    } catch (err) {
        console.error('Error generating PDF:', err);
        throw new Error('PDF generation failed');
    }
}

module.exports = { renderPdfFromHtml };
