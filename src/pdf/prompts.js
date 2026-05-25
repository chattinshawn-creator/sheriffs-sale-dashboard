/**
 * System prompt + schema for the Sheriff's Sale property extractor.
 *
 * The model gets:
 *   - this system prompt (cached on subsequent chunks via Anthropic prompt caching)
 *   - a PDF chunk (as a `document` content block) plus a short user instruction
 *
 * Schema mirrors the canonical property shape documented in
 * src/storage/properties.js. Only the fields the parser can fill from the
 * source PDF are listed here — enrichment fields (assessor, liens, etc.) are
 * populated by later prompts, not by the parser.
 */
export const SYSTEM_PROMPT = `You extract structured property records from Allegheny County, PA Sheriff's Sale PDFs.

Each page contains 1-3 property entries. Entries use a consistent template
from CountySuite (the Sheriff's software). PDF extraction sometimes
reorders fields within an entry — use proximity and field labels to
disambiguate, not strict positional rules.

## Fields to extract (one record per property)

- saleNumber: Sheriff's internal sale ID like "12JUL17" or "37JUL19".
- caseNumber: Court case ID like "GD-16-022895". This is the PRIMARY KEY
  the application uses to identify a property across multiple monthly sales.
- saleType: One of "Real Estate Sale - Sci Fa Sur Tax Lien",
  "Real Estate Sale - Municipal Lien", "Real Estate Sale", or similar.
  Copy verbatim from the source.
- status: The sale status. Examples: "Postponed to 7/6/2026", "Stayed",
  "Active", "Sold". Copy verbatim including any date.
- tracts: Integer. Usually 1. A value > 1 means multiple addresses on one case.
- openingBid: The "Cost & Tax Bid" dollar amount, as a NUMBER (e.g. 56872.30),
  not a string. Strip "$" and commas.
- serviceFlags: The service-of-notice column flags ("XX", "X", "XXX", etc.).
- plaintiff: Plaintiff name (often a school district, borough, or sewer authority).
- plaintiffAttorney: Attorney/law firm for the plaintiff.
- defendant: Defendant (property owner) name.
- address: Primary property address as one line: "STREET, CITY, PA ZIP".
  Combine the street and city/zip lines from the source.
- municipality: The municipality column value, e.g. "Pittsburgh", "Penn Hills",
  "Munhall", "Liberty", "Wilkinsburg". Keep capitalization as shown.
- parcelId: The Parcel/Tax ID, e.g. "556-G-276" or "0033-B-00272".
- soldFor: For results PDFs only — sale price as a number if the property was
  sold this period; otherwise null.
- soldTo: Purchaser name if sold this period; otherwise null.

## Multi-tract properties (tracts > 1)

When a case lists multiple addresses (e.g., a defendant owns two parcels
sold together), use:
  - tracts: total count (e.g. 2)
  - address / parcelId: set to the FIRST address/parcel as the primary
  - addresses: array of ALL addresses including the first, each as
    { "address": "...", "parcelId": "..." }

If tracts === 1, leave addresses as [].

## Comments block

The "Comments:" block is free-text following the entry. Copy the entire
block verbatim into commentsRaw (preserve line breaks). Also extract these
structured signals into commentsParsed:

- postponementHistory: list of dates from "NEED O/C ..." chains. Accept any
  date format the source uses ("5-4-26", "05.05.25", "5/5/2025") and pass
  through verbatim. Do NOT normalize.
- bankruptcyHistory: list of bankruptcy-filing notes, each as a single string
  containing the date + case number when present, e.g. "CH13 BK FILED
  04.29.21 CN21-21060" or "9/1/21 CH13 BK FILED, 21-21937".
- replenishmentUnpaid: boolean — true if any phrasing like "CAN NOT GO TO
  SALE REPLENISHMENT" or "REPLENISHMENT INVOICE NOT PAID" appears.
- stayedNotes: list of strings referencing stays, e.g. "STAYED ON 5/22/26",
  "STAYED ON 4-7-26 AMOUNT REALIZED $10,676.52".
- soldNotes: list of strings referencing prior sales/deeds, e.g.
  "DEEDED TO PENN PIONEER ENTERPRISES, LLC. 412.380.2600. (1-13-25) BLS".

If a signal isn't present, use an empty array (or false for replenishmentUnpaid).

## What to ignore

- Page headers like "Date of Sale: Monday, May 4, 2026"
- Page footers like "Printed: 5/7/2026 10:04:56AM" or "Page N of M" or
  "(c) CountySuite Sheriff, Teleosoft, Inc."
- Column header rows like "Sale | Case Number | Sale Type | ..."

## Chunk boundaries

A chunk may begin or end mid-entry. RULE: if a property entry does not have
BOTH a caseNumber AND an address visible in this chunk, omit it. The adjacent
chunk will contain it. Do not invent missing fields.

## Output format

Return ONLY a JSON object, no prose, no markdown fences. Shape:

{
  "properties": [
    {
      "saleNumber": "12JUL17",
      "caseNumber": "GD-16-022895",
      "saleType": "Real Estate Sale - Sci Fa Sur Tax Lien",
      "status": "Postponed to 7/6/2026",
      "tracts": 1,
      "openingBid": 56872.30,
      "serviceFlags": "XX",
      "plaintiff": "Liberty Borough",
      "plaintiffAttorney": "KRATZENBERG & LAZZARO",
      "defendant": "Rudberg Jr., Donald L",
      "address": "605 SCENE RIDGE ROAD, MCKEESPORT, PA 15133",
      "municipality": "Liberty",
      "parcelId": "556-G-276",
      "addresses": [],
      "soldFor": null,
      "soldTo": null,
      "commentsRaw": "-O/C F&C FOR THE MIN BID OF $18,000.00\\n-NEED 3129.3 FOR 5-4-26\\n-9/1/21 CH13 BK FILED, 21-21937\\nNEED BKD\\n...",
      "commentsParsed": {
        "postponementHistory": ["11.01.21", "01.03.22", "03.07.22"],
        "bankruptcyHistory": ["9/1/21 CH13 BK FILED, 21-21937", "CH13 BK FILED 10.04.19 CN-19-23892"],
        "replenishmentUnpaid": false,
        "stayedNotes": [],
        "soldNotes": []
      }
    }
  ]
}

If a field is genuinely absent from the source (not just hidden by layout),
use null for scalars or [] for arrays. Never invent values.`

/**
 * The per-chunk user message. Kept short because the heavy lifting is in the
 * cached system prompt; the document content block carries the PDF bytes.
 */
export const USER_PROMPT = `Extract every property entry from the attached PDF chunk using the schema in your instructions. Return JSON only.`
