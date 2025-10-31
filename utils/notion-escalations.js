const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN || process.env.NOTION_API_KEY,
});

function normalizeDbId(id) {
    if (!id) return id;
    return id.replace(/-/g, '');
}

const notionUserEmailCache = new Map();

async function getNotionUserIdByEmail(email) {
    if (!email) return null;
    if (notionUserEmailCache.has(email)) return notionUserEmailCache.get(email);

    let cursor = undefined;
    try {
        do {
            const res = await notion.users.list({ start_cursor: cursor });
            for (const u of res.results || []) {
                if (u.type === 'person' && u.person && u.person.email) {
                    if (u.person.email.toLowerCase() === email.toLowerCase()) {
                        notionUserEmailCache.set(email, u.id);
                        return u.id;
                    }
                }
            }
            cursor = res.has_more ? res.next_cursor : undefined;
        } while (cursor);
    } catch (err) {
        console.error('[notion] users.list failed', {
            err: err?.message || err,
        });
    }

    notionUserEmailCache.set(email, null);
    return null;
}

function findPropByNames(dbProps, names = []) {
    for (const n of names) {
        if (Object.prototype.hasOwnProperty.call(dbProps, n)) return dbProps[n];
    }
    return null;
}

function buildPropertyPayload(dbProperties, values = {}) {
    const {
        listing,
        booking,
        guest,
        summary,
        issues = [],
        assigneeNames = [],
        notionAssigneeIds = [],
        submittedByName = '',
        attachments_present = false,
        thread_channel,
        thread_ts,
    } = values;

    const props = {};
    const prop = name => dbProperties[name] || null;

    const listingProp =
        prop('Listing') || prop('Listing name') || prop('Title');
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

    const bookingProp = prop('Booking reference') || prop('Booking');
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

    const guestProp = prop('Guest') || prop('Guest name');
    if (guestProp) {
        props[guestProp.name] = {
            rich_text: [{ text: { content: guest || '' } }],
        };
    }

    const summaryProp = prop('Summary');
    if (summaryProp) {
        props[summaryProp.name] = {
            rich_text: [{ text: { content: summary || '' } }],
        };
    }

    const issuesProp =
        prop('Issue type') || prop('Issue') || prop('Issue Type');
    if (issuesProp) {
        if (issuesProp.type === 'multi_select') {
            props[issuesProp.name] = {
                multi_select: (issues || []).map(i => ({ name: String(i) })),
            };
        } else {
            props[issuesProp.name] = {
                rich_text: [{ text: { content: (issues || []).join(', ') } }],
            };
        }
    }

    const assignProp = prop('Assigned To');
    if (assignProp) {
        if (assignProp.type === 'people') {
            if (Array.isArray(notionAssigneeIds) && notionAssigneeIds.length) {
                props[assignProp.name] = {
                    people: notionAssigneeIds.map(id => ({ id })),
                };
            } else {
                console.warn(
                    '[notion] Assigned To property is people but no notionAssigneeIds provided.'
                );
                const fallback =
                    prop('Assigned To (text)') || prop('Assignee (Slack IDs)');
                if (fallback) {
                    props[fallback.name] = {
                        rich_text: [
                            {
                                text: {
                                    content: assigneeNames.join(', ') || '',
                                },
                            },
                        ],
                    };
                }
            }
        } else {
            props[assignProp.name] = {
                rich_text: [
                    { text: { content: assigneeNames.join(', ') || '' } },
                ],
            };
        }
    } else {
        console.warn(
            '[notion] WARNING: Database has no "Assigned To" property (case-sensitive).'
        );
    }

    const subProp = prop('Submitted by');
    if (subProp) {
        props[subProp.name] = {
            rich_text: [{ text: { content: submittedByName || '' } }],
        };
    }

    const attProp = prop('Attachments') || prop('Attachment');
    if (attProp) {
        if (attProp.type === 'checkbox') {
            props[attProp.name] = { checkbox: !!attachments_present };
        } else {
            props[attProp.name] = {
                rich_text: [
                    { text: { content: attachments_present ? 'Yes' : 'No' } },
                ],
            };
        }
    }

    const threadObj =
        prop('Thread URL') || prop('Thread_URL') || prop('Thread');
    if (threadObj && values.thread_url) {
        if (threadObj.type === 'url') {
            props[threadObj.name] = { url: values.thread_url };
        } else {
            props[threadObj.name] = {
                rich_text: [{ text: { content: values.thread_url } }],
            };
        }
    }

    const threadChannelProp =
        prop('Thread Channel ID') ||
        prop('Thread_Channel_ID') ||
        prop('Thread Channel');
    if (threadChannelProp && thread_channel) {
        props[threadChannelProp.name] = {
            rich_text: [{ text: { content: String(thread_channel) } }],
        };
    }
    const threadTsProp =
        prop('Thread TS') || prop('Thread_TS') || prop('Thread Timestamp');
    if (threadTsProp && thread_ts) {
        props[threadTsProp.name] = {
            rich_text: [{ text: { content: String(thread_ts) } }],
        };
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
            errMessage: err?.message || err,
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
        await notion.pages.update(payload);
        return;
    }

    const propName = threadProp.name;
    let updatePayload = {};
    if (threadProp.type === 'url') {
        updatePayload[propName] = { url: fields.thread_url || null };
    } else {
        updatePayload[propName] = {
            rich_text: [{ text: { content: fields.thread_url || '' } }],
        };
    }

    const threadChannelProp =
        dbProps['Thread Channel ID'] ||
        dbProps['Thread_Channel_ID'] ||
        dbProps['Thread Channel'];
    if (threadChannelProp && fields.thread_channel) {
        updatePayload[threadChannelProp.name] = {
            rich_text: [{ text: { content: String(fields.thread_channel) } }],
        };
    }
    const threadTsProp =
        dbProps['Thread TS'] ||
        dbProps['Thread_TS'] ||
        dbProps['Thread Timestamp'];
    if (threadTsProp && fields.thread_ts) {
        updatePayload[threadTsProp.name] = {
            rich_text: [{ text: { content: String(fields.thread_ts) } }],
        };
    }

    await notion.pages.update({ page_id: pageId, properties: updatePayload });
}

module.exports = {
    createNotionTicket,
    updateNotionTicketWithThread,
    getNotionUserIdByEmail,
};
