const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN || process.env.NOTION_API_KEY,
});

function normalizeDbId(id) {
    if (!id) return id;
    return id.replace(/-/g, '');
}

function findProp(dbProps, candidates = []) {
    for (const c of candidates) {
        if (dbProps[c]) return dbProps[c];
        const found = Object.values(dbProps).find(
            p => (p.name || '').toLowerCase() === c.toLowerCase()
        );
        if (found) return found;
    }
    return null;
}

function safeTitleOrRichText(propName, dbProps, keyName, value) {
    const prop = findProp(dbProps, [propName, keyName]);
    if (!prop) return null;
    if (prop.type === 'title') {
        return { [prop.name]: { title: [{ text: { content: value || '' } }] } };
    } else {
        return {
            [prop.name]: { rich_text: [{ text: { content: value || '' } }] },
        };
    }
}

function buildPropertyPayload(dbProperties, values = {}) {
    const {
        listing,
        booking,
        guest,
        summary,
        issues = [],
        assignees = [],
        assigneeNames = [],
        submittedByName = '',
        attachments = [],
        notionAssigneeIds = [],
    } = values;

    const props = {};
    const prop = name => dbProperties[name] || null;

    const listingProp = findProp(dbProperties, ['Listing', 'Title', 'Name']);
    if (listingProp) {
        if (listingProp.type === 'title') {
            props[listingProp.name] = {
                title: [{ text: { content: listing || 'No listing' } }],
            };
        } else {
            props[listingProp.name] = {
                rich_text: [{ text: { content: listing || 'No listing' } }],
            };
        }
    }

    const bookingProp = findProp(dbProperties, [
        'Booking reference',
        'Booking',
        'Booking Reference',
    ]);
    if (bookingProp) {
        if (bookingProp.type === 'title') {
            props[bookingProp.name] = {
                title: [{ text: { content: booking || '' } }],
            };
        } else {
            props[bookingProp.name] = {
                rich_text: [{ text: { content: booking || '' } }],
            };
        }
    }

    const guestProp = findProp(dbProperties, [
        'Guest',
        'Guest name',
        'Guest Name',
    ]);
    if (guestProp) {
        if (guestProp.type === 'multi_select') {
            props[guestProp.name] = {
                multi_select: (guest || '')
                    .split(',')
                    .map(g => ({ name: g.trim() }))
                    .filter(x => x.name),
            };
        } else {
            props[guestProp.name] = {
                rich_text: [{ text: { content: guest || '' } }],
            };
        }
    }

    const summaryProp = findProp(dbProperties, ['Summary']);
    if (summaryProp)
        props[summaryProp.name] = {
            rich_text: [{ text: { content: summary || '' } }],
        };

    const issuesProp = findProp(dbProperties, [
        'Issue type',
        'Issue Type',
        'Issue',
    ]);
    if (issuesProp) {
        if (
            issuesProp.type === 'multi_select' ||
            issuesProp.type === 'select'
        ) {
            props[issuesProp.name] = {
                multi_select: issues.map(i => ({ name: String(i) })),
            };
        } else {
            props[issuesProp.name] = {
                rich_text: [{ text: { content: (issues || []).join(', ') } }],
            };
        }
    }

    const assignProp = findProp(dbProperties, [
        'Assigned To',
        'Assigned',
        'Assignee',
    ]);
    if (assignProp) {
        if (assignProp.type === 'people') {
            if (Array.isArray(notionAssigneeIds) && notionAssigneeIds.length) {
                props[assignProp.name] = {
                    people: notionAssigneeIds.map(id => ({ id })),
                };
            } else {
                const companion = findProp(dbProperties, [
                    'Assignee (Slack)',
                    'Assignee Names',
                    'Assigned (text)',
                ]);
                if (companion) {
                    props[companion.name] = {
                        rich_text: [
                            {
                                text: {
                                    content:
                                        (assigneeNames || []).join(', ') ||
                                        'N/A',
                                },
                            },
                        ],
                    };
                }
            }
        } else {
            props[assignProp.name] = {
                rich_text: [
                    { text: { content: (assigneeNames || []).join(', ') } },
                ],
            };
        }
    }
    const subProp = findProp(dbProperties, [
        'Submitted by',
        'Submitted_by',
        'Submitted',
    ]);
    if (subProp) {
        if (subProp.type === 'people') {
            const companion = findProp(dbProperties, [
                'Submitted by (text)',
                'Submitted Name',
                'Submitted Plain',
            ]);
            if (companion)
                companion &&
                    (props[companion.name] = {
                        rich_text: [
                            { text: { content: submittedByName || '' } },
                        ],
                    });
            else {
            }
        } else {
            props[subProp.name] = {
                rich_text: [{ text: { content: submittedByName || '' } }],
            };
        }
    }

    const attProp = findProp(dbProperties, [
        'Attachments',
        'Attachment',
        'Files',
    ]);
    if (attProp) {
        if (attProp.type === 'files') {
            props[attProp.name] = {
                files: (attachments || []).map(url => ({
                    name: url.split('/').pop(),
                    type: 'external',
                    external: { url },
                })),
            };
        } else {
            props[attProp.name] = {
                rich_text: [
                    { text: { content: (attachments || []).join(', ') } },
                ],
            };
        }
    }

    return props;
}

async function createNotionTicket(data = {}) {
    const dbIdRaw = process.env.NOTION_ESCALATIONS_DB_ID;
    if (!dbIdRaw) throw new Error('NOTION_ESCALATIONS_DB_ID not set');
    const dbId = normalizeDbId(dbIdRaw);

    let db;
    try {
        db = await notion.databases.retrieve({ database_id: dbId });
    } catch (err) {
        console.error('[notion] failed to retrieve database:', {
            dbId,
            errMessage: err?.message,
            errBody: err?.body || err?.response || null,
        });
        throw err;
    }
    const dbProps = db.properties || {};

    const properties = buildPropertyPayload(dbProps, data);

    if (!Object.keys(properties).length) {
        properties['Title'] = {
            title: [{ text: { content: data.listing || 'Ticket' } }],
        };
    }

    const payload = { parent: { database_id: dbId }, properties };

    console.log('[notion] creating page, payload sample:', {
        dbId,
        propertiesSent: Object.keys(properties),
    });

    try {
        const page = await notion.pages.create(payload);
        console.log('[notion] page created:', { id: page.id, url: page.url });
        return { id: page.id, url: page.url };
    } catch (err) {
        console.error('[notion] pages.create failed:', {
            message: err?.message,
            status: err?.status,
            body: err?.body || err?.response || null,
        });
        throw err;
    }
}

async function updateNotionTicketWithThread(pageId, fields = {}) {
    if (!pageId) throw new Error('pageId required');
    const dbIdRaw = process.env.NOTION_ESCALATIONS_DB_ID;
    if (!dbIdRaw) throw new Error('NOTION_ESCALATIONS_DB_ID not set');
    const dbId = normalizeDbId(dbIdRaw);

    const db = await notion.databases.retrieve({ database_id: dbId });
    const dbProps = db.properties || {};
    const threadProp =
        dbProps['Thread URL'] ||
        dbProps['Thread_URL'] ||
        dbProps['Thread'] ||
        null;

    if (!threadProp) {
        const payload = {
            page_id: pageId,
            properties: {
                'Thread URL': {
                    rich_text: [{ text: { content: fields.thread_url || '' } }],
                },
            },
        };
        try {
            await notion.pages.update(payload);
            return;
        } catch (err) {
            throw err;
        }
    }

    const propName = threadProp.name;
    let updatePayload = {};
    if (threadProp.type === 'url')
        updatePayload[propName] = { url: fields.thread_url || null };
    else
        updatePayload[propName] = {
            rich_text: [{ text: { content: fields.thread_url || '' } }],
        };

    await notion.pages.update({ page_id: pageId, properties: updatePayload });
}

module.exports = { createNotionTicket, updateNotionTicketWithThread };
