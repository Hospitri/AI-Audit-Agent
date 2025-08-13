const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

async function scrapePage(url) {
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.evaluate(async () => {
        await new Promise(resolve => {
            let totalHeight = 0;
            const distance = 400;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= document.body.scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 200);
        });
    });

    const html = await page.content();
    await browser.close();

    const $ = cheerio.load(html);
    $('script, style, noscript').remove();

    const selectors = [
        'title',
        'meta[property="og:title"]',
        'meta[name="description"]',
        'meta[property="og:description"]',
        '[data-section-id="DESCRIPTION_DEFAULT"]',
        '[data-section-id="AMENITIES_DEFAULT"]',
        '[data-section-id="POLICIES_DEFAULT"]',
        '[data-section-id="REVIEWS_DEFAULT"]',
        '[data-testid="book-it-default"]',
        '[data-section-id*="HOST_PROFILE_DEFAULT"]',
    ];

    let extracted = '';

    selectors.forEach(sel => {
        const el = $(sel);
        if (el.length) {
            const text = el.text().trim() || el.attr('content');
            if (text) {
                extracted += `\n[${sel}]\n${text}`;
            }
        }
    });

    const images = [];
    $('img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src && !images.includes(src)) images.push(src);
    });
    if (images.length) {
        extracted += `\n[images]\n${images.slice(0, 20).join('\n')}`;
    }

    return extracted.replace(/\s+/g, ' ').trim();
}

module.exports = { scrapePage };
