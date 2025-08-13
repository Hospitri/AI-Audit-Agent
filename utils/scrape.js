const puppeteer = require('puppeteer');

function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

async function gotoWithRetries(page, url, tries = 2) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
            return;
        } catch (e) {
            lastErr = e;
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
    throw lastErr;
}

async function maybeAcceptCookies(page) {
    const selectors = [
        '#onetrust-accept-btn-handler',
        'button#onetrust-accept-btn-handler',
        'button[aria-label="Accept all"]',
        'button[aria-label="Accept"]',
        'button:has-text("Accept all")',
        'button:has-text("Accept")',
        'button:has-text("I agree")',
    ];
    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (btn) {
                await btn.click({ delay: 50 });
                await page.waitForTimeout(500);
                break;
            }
        } catch {}
    }
}

async function safeScroll(page) {
    try {
        await page.evaluate(async () => {
            await new Promise(resolve => {
                let total = 0;
                const step = 500;
                const id = setInterval(() => {
                    window.scrollBy(0, step);
                    total += step;
                    if (total >= document.body.scrollHeight) {
                        clearInterval(id);
                        resolve();
                    }
                }, 200);
            });
        });
    } catch {}
}

function uniq(arr) {
    return [...new Set(arr.filter(Boolean).map(s => s.trim()))];
}

async function extractCommon(page) {
    const title = await page.title();
    const ogTitle = await page
        .$eval('meta[property="og:title"]', el => el.content, { timeout: 0 })
        .catch(() => '');
    const metaDesc = await page
        .$eval('meta[name="description"]', el => el.content, { timeout: 0 })
        .catch(() => '');
    const ogDesc = await page
        .$eval('meta[property="og:description"]', el => el.content, {
            timeout: 0,
        })
        .catch(() => '');

    const images = await page
        .$$eval('img', imgs =>
            imgs
                .map(
                    img =>
                        img.getAttribute('src') ||
                        img.getAttribute('data-src') ||
                        img.getAttribute('srcset')
                )
                .filter(Boolean)
        )
        .catch(() => []);

    return {
        title: ogTitle || title || '',
        description: ogDesc || metaDesc || '',
        images: uniq(images).slice(0, 30),
    };
}

async function extractAirbnb(page) {
    await page
        .waitForSelector('div[data-section-id="DESCRIPTION_DEFAULT"], h1', {
            timeout: 8000,
        })
        .catch(() => {});
    const common = await extractCommon(page);

    const blocks = [];

    const sectionIds = [
        'DESCRIPTION_DEFAULT',
        'AMENITIES_DEFAULT',
        'POLICIES_DEFAULT',
        'REVIEWS_DEFAULT',
    ];
    for (const id of sectionIds) {
        const text = await page
            .$$eval(
                `[data-section-id="${id}"]`,
                nodes => nodes.map(n => n.innerText).join('\n'),
                { timeout: 0 }
            )
            .catch(() => '');
        if (text) blocks.push(`[${id}]\n${text}`);
    }

    const price = await page
        .$$eval(
            '[data-testid="book-it-default"]',
            nodes => nodes.map(n => n.innerText).join('\n'),
            { timeout: 0 }
        )
        .catch(() => '');
    if (price) blocks.push(`[PRICE]\n${price}`);

    const host = await page
        .$$eval(
            '[data-section-id*="HOST_PROFILE_DEFAULT"]',
            nodes => nodes.map(n => n.innerText).join('\n'),
            { timeout: 0 }
        )
        .catch(() => '');
    if (host) blocks.push(`[HOST]\n${host}`);

    return {
        ...common,
        extractedText: uniq(blocks.join('\n\n').split('\n'))
            .join('\n')
            .slice(0, 200000),
    };
}

async function extractVrbo(page) {
    await page
        .waitForSelector('h1[data-stid="content-h1"], h1', { timeout: 8000 })
        .catch(() => {});
    const common = await extractCommon(page);

    const blocks = [];

    const sections = [
        { tag: 'TITLE', sel: 'h1[data-stid="content-h1"], h1' },
        {
            tag: 'OVERVIEW',
            sel: '[data-stid="content-overview"], #overview, section[data-stid="overview"]',
        },
        {
            tag: 'AMENITIES',
            sel: '#amenities, section#amenities, [data-stid="amenities"]',
        },
        {
            tag: 'REVIEWS',
            sel: '#reviews, section#reviews, [data-stid="review-summary"]',
        },
        {
            tag: 'PRICE',
            sel: '[data-stid="price-summary"], [data-stid="price-lockup-text"]',
        },
        {
            tag: 'POLICIES',
            sel: '#policies, section#policies, [data-stid="policies"]',
        },
        { tag: 'HOST', sel: '[data-stid="host-profile"], #host, section#host' },
    ];

    for (const s of sections) {
        const text = await page
            .$$eval(s.sel, nodes => nodes.map(n => n.innerText).join('\n'), {
                timeout: 0,
            })
            .catch(() => '');
        if (text) blocks.push(`[${s.tag}]\n${text}`);
    }

    return {
        ...common,
        extractedText: uniq(blocks.join('\n\n').split('\n'))
            .join('\n')
            .slice(0, 200000),
    };
}

async function extractBooking(page) {
    await page
        .waitForSelector('h2[data-testid="title"], h1', { timeout: 8000 })
        .catch(() => {});
    const common = await extractCommon(page);

    const blocks = [];

    const sections = [
        { tag: 'TITLE', sel: 'h2[data-testid="title"], h1' },
        {
            tag: 'DESCRIPTION',
            sel: 'div[data-testid="property-description"], #property_description_content',
        },
        {
            tag: 'AMENITIES',
            sel: 'div[data-testid="property-facilities"], #hotelFacilitiesSection',
        },
        {
            tag: 'REVIEWS',
            sel: 'div[data-testid="review-score"], #guest-reviews',
        },
        {
            tag: 'PRICE',
            sel: 'div[data-testid="price-and-discounted-price"], .prc-d-container',
        },
        {
            tag: 'POLICIES',
            sel: 'div[data-testid="house-rules-section"], #hotelPoliciesInc',
        },
    ];

    for (const s of sections) {
        const text = await page
            .$$eval(s.sel, nodes => nodes.map(n => n.innerText).join('\n'), {
                timeout: 0,
            })
            .catch(() => '');
        if (text) blocks.push(`[${s.tag}]\n${text}`);
    }

    return {
        ...common,
        extractedText: uniq(blocks.join('\n\n').split('\n'))
            .join('\n')
            .slice(0, 200000),
    };
}

async function scrapePage(url) {
    const host = hostOf(url);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
    });
    const page = await browser.newPage();

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
    });
    await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });

    await gotoWithRetries(page, url);

    await maybeAcceptCookies(page);

    await page.waitForTimeout(1000).catch(() => {});
    await safeScroll(page);
    await page.waitForTimeout(500).catch(() => {});

    let result;
    if (host.includes('airbnb.')) {
        result = await extractAirbnb(page);
    } else if (host.includes('vrbo.')) {
        result = await extractVrbo(page);
    } else if (host.includes('booking.')) {
        result = await extractBooking(page);
    } else {
        const common = await extractCommon(page);
        const bodyText = await page
            .evaluate(() => document.body.innerText)
            .catch(() => '');
        result = {
            ...common,
            extractedText: (bodyText || '').slice(0, 200000),
        };
    }

    if (!result.extractedText || result.extractedText.length < 2000) {
        const bodyText = await page
            .evaluate(() => document.body.innerText)
            .catch(() => '');
        result.extractedText = (bodyText || '').slice(0, 200000);
    }

    await browser.close();

    const payload = [
        result.title ? `[TITLE]\n${result.title}` : '',
        result.description ? `[META_DESCRIPTION]\n${result.description}` : '',
        result.extractedText ? `[EXTRACTED]\n${result.extractedText}` : '',
        result.images && result.images.length
            ? `[IMAGES]\n${result.images.join('\n')}`
            : '',
    ]
        .filter(Boolean)
        .join('\n\n')
        .replace(/\s+\n/g, '\n')
        .trim();

    return payload;
}

module.exports = { scrapePage };
