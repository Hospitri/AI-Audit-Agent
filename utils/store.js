const { pool } = require('./db');

async function insertLead(client, data) {
    const q = `
    INSERT INTO leads
      (name, email, phone, location, classification_id, lead_status_id, demo_status_id,
       priority_id, range_bucket_id, actual_listings, source_id, source_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `;
    const vals = [
        data.name ?? null,
        data.email ?? null,
        data.phone ?? null,
        data.location ?? null,
        data.classification_id ?? null,
        data.lead_status_id ?? null,
        data.demo_status_id ?? null,
        data.priority_id ?? null,
        data.range_bucket_id ?? null,
        data.actual_listings ?? null,
        data.source_id ?? null,
        data.source_url ?? null,
    ];
    const { rows } = await client.query(q, vals);
    return rows[0].id;
}

async function addLeadToList(client, leadId, listId) {
    const q = `
    INSERT INTO lead_list_memberships (lead_id, list_id)
    VALUES ($1, $2)
    ON CONFLICT (lead_id, list_id) DO NOTHING
  `;
    await client.query(q, [leadId, listId]);
}

async function insertAudit(client, data) {
    const q = `
    INSERT INTO audits (lead_id, listing_url, listing_title, overall_score, submission_id)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (submission_id) DO NOTHING
    RETURNING id
  `;
    const vals = [
        data.lead_id,
        data.listing_url,
        data.listing_title ?? null,
        data.overall_score ?? null,
        data.submission_id ?? null,
    ];
    const { rows } = await client.query(q, vals);
    return rows[0]?.id || null;
}

module.exports = { insertLead, addLeadToList, insertAudit };
