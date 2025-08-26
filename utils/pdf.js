const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const puppeteer = require('puppeteer');

function toFileURL(p) {
    const u = 'file://' + p.replace(/\\/g, '/');
    return u.endsWith('/') ? u : u + '/';
}

async function renderPdfFromHtml(html, opts = {}) {
    const { baseDir } = opts;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-'));
    const wrapperPath = path.join(tmpDir, 'audit-wrapper.html');

    const hasBase = /<base\s/i.test(html);
    const injectedHead = [
        '<head>',
        !hasBase && baseDir ? `<base href="${toFileURL(baseDir)}">` : '',
        '<meta name="viewport" content="width=1060, initial-scale=1">',
        '<style>@page{margin:0;}html,body{margin:0;padding:0;}body{padding:12mm 10mm;} .page-break{break-after:page;page-break-after:always;}</style>',
        '<script src="https://cdn.tailwindcss.com"></script>',
        '<script>document.addEventListener("DOMContentLoaded",()=>{setTimeout(()=>document.documentElement.setAttribute("data-tw-ready","1"),100)})</script>',
    ].join('');

    const wrapped = String(html).replace(/<head>/i, injectedHead);
    await fs.writeFile(wrapperPath, wrapped, 'utf8');

    const browser = await puppeteer.launch({
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--font-render-hinting=medium',
        ],
    });
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(true);
    await page.emulateMediaType('screen');
    await page.setViewport({ width: 1140, height: 1600, deviceScaleFactor: 2 });

    await page.goto('file://' + wrapperPath.replace(/\\/g, '/'), {
        waitUntil: 'networkidle0',
    });
    await page
        .waitForFunction(
            () => {
                const twReady =
                    document.documentElement.getAttribute('data-tw-ready') ===
                    '1';
                const hasTailwindCSS = [...document.styleSheets].some(s => {
                    try {
                        return (
                            s.ownerNode &&
                            s.ownerNode.tagName === 'STYLE' &&
                            (s.ownerNode.textContent || '').includes('--tw')
                        );
                    } catch {
                        return false;
                    }
                });
                return twReady && hasTailwindCSS;
            },
            { timeout: 10000 }
        )
        .catch(() => {});

    const pdfPath = path.join(tmpDir, `audit-${Date.now()}.pdf`);
    const scale = Math.max(
        0.6,
        Math.min(1, parseFloat(process.env.PDF_SCALE || '0.82'))
    );

    await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        scale,
    });

    await browser.close();
    return pdfPath;
}

module.exports = { renderPdfFromHtml };
