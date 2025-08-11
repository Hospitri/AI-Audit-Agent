const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

async function fetchHtml(url) {
    const resp = await fetch(url, {
        headers: { 'User-Agent': 'HospitriAuditBot/1.0' },
    });
    const text = await resp.text();
    return text;
}

async function renderWithPuppeteer(url) {
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    const html = await page.content();
    await browser.close();
    return html;
}

async function scrapePage(url) {
    let html = await fetchHtml(url);
    let $ = cheerio.load(html);

    // If page seems JS-rendered (title empty or body small), fallback to Puppeteer
    const title = $('title').text().trim();
    if (!title || html.length < 2000) {
        console.log('Falling back to Puppeteer');
        html = await renderWithPuppeteer(url);
        $ = cheerio.load(html);
    }

    // Extract basics
    const titleText =
        $('meta[property="og:title"]').attr('content') || $('title').text();
    const desc =
        $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') ||
        '';
    const images = [];
    // OG image first
    const og = $('meta[property="og:image"]').attr('content');
    if (og) images.push(og);
    $('img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src && images.indexOf(src) === -1) images.push(src);
    });

    const amenities = [];
    $('*').each((i, el) => {
        const text = $(el).text().trim();
        if (
            /amenities|características|facilities|services/i.test(text) &&
            $(el).find('li').length
        ) {
            $(el)
                .find('li')
                .each((_, li) => {
                    const amenity = $(li).text().trim();
                    if (amenity) amenities.push(amenity);
                });
        }
    });

    const reviews = [];
    $('[class*="review"], [class*="rating"], [class*="score"]').each(
        (_, el) => {
            const reviewText = $(el).text().trim();
            if (reviewText && reviews.indexOf(reviewText) === -1)
                reviews.push(reviewText);
        }
    );

    let pricing = null;
    const priceCandidates = [];
    $('body *').each((_, el) => {
        const t = $(el).text().trim();
        if (/\$\d+|USD|€\d+|price/i.test(t)) {
            priceCandidates.push(t);
        }
    });
    if (priceCandidates.length) pricing = priceCandidates[0];

    const policies = [];
    $('*').each((_, el) => {
        const text = $(el).text().trim();
        if (
            /policy|política|terms|fees|charges/i.test(text) &&
            text.length < 500
        ) {
            policies.push(text);
        }
    });

    let responseSpeed = null;
    $('*').each((_, el) => {
        const text = $(el).text().trim();
        if (/responds within|tiempo de respuesta/i.test(text)) {
            responseSpeed = text;
        }
    });

    return {
        title: titleText,
        description: desc,
        images: images.slice(0, 50),
        amenities_consistency: amenities,
        review_sentiment: reviews,
        pricing,
        policies_fees: policies,
        response_speed: responseSpeed,
    };
}

module.exports = { scrapePage };
