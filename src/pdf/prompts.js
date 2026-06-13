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
- caseNumber: Court case ID. **Format: "XX-YY-NNNNNN"** where XX is a
  2-letter prefix (commonly "GD" = General Docket for tax sales, "MG" =
  Mortgage for foreclosures, also "AR", "CV", etc.), YY is a 2-digit year
  (12 through 26 in current data), and NNNNNN is a 6-digit case number.
  Examples: "GD-16-022895", "MG-14-000165", "GD-20-011178". This is the
  PRIMARY KEY the application uses to identify a property across multiple
  monthly sales. If you cannot read a case number that cleanly matches this
  format, return null rather than guessing — do NOT invent digits or letters.
- saleType: The full sale type. Copy verbatim. Common values include:
  "Real Estate Sale - Sci Fa Sur Tax Lien" (county tax lien)
  "Real Estate Sale - Municipal Lien" (city/borough lien)
  "Real Estate Sale - Mortgage Foreclosure" (bank foreclosure)
  "Real Estate Sale" (generic)
  Plus other variations.
- status: The sale status / outcome. Copy verbatim including any date or
  dollar amount. On a RESULTS PDF this field encodes what actually happened
  using a specific vocabulary — recognize these exact forms:
    "Third Party - $X"        the property SOLD to an outside bidder for $X
                              (X is the true market price the buyer paid).
    "PLTF Overbid - $X"       the plaintiff bid above its cost; sold back to
                              the plaintiff for $X.
    "PLTF Cost - $X" or
    "PLTF Cost & Tax - $X"    went back to the plaintiff at cost for $X.
    "Money Made"              sold; proceeds exceeded the debt (a price may or
                              may not be shown).
    "Postponed to <date>",
    "Postponed (Waived) to <date>",
    "PP Generally"            rolled to a later sale.
    "Stayed"                  the sale was halted.
  On a LISTINGS PDF the status is typically "Active", "Postponed to <date>",
  or "Stayed". Copy whatever the source shows, verbatim.
- tracts: Integer. Usually 1. A value > 1 means multiple addresses on one case.
- openingBid: The "Cost & Tax Bid" dollar amount, as a NUMBER (e.g. 56872.30),
  not a string. Strip "$" and commas.
- serviceFlags: The service-of-notice column flags as shown ("XX", "X", "XXX", etc.).
- serviceOk: boolean. The service column is a row of checkboxes with headers
  like "Svs", "3129.2", "3129.3", "OK" (left to right). Set serviceOk to TRUE
  only if the RIGHTMOST "OK" box is marked with an X (the property is cleared
  and ready to go to sale). Set FALSE if the OK box is empty. If you genuinely
  cannot tell, use null.
- serviceCheckedCount: integer — how many of the service checkboxes in that row
  are marked with an X. Use 0 if none are checked. This lets the app tell
  "no progress" (0) from "in progress but not cleared" (>0, OK empty).
- plaintiff: Plaintiff name. Plaintiff type depends on sale type:
  - Tax-lien sales: a school district, borough, township, or
    sewer/water authority (e.g. "Munhall Borough", "Penn Hills School District")
  - Mortgage foreclosure sales: a bank, mortgage company, or loan servicer
    (e.g. "U.S. Bank Trust National Association", "Nationstar Mortgage LLC",
    "Specialized Loan Servicing LLC", "Wells Fargo Bank, N.A."). These
    LEGITIMATELY contain "LLC", "N.A.", "TRUST", etc. — those suffixes do
    NOT mean the value got column-shifted from the attorney field.
- plaintiffAttorney: Attorney/law firm for the plaintiff.
- defendant: Defendant (property owner) name.
- address: Primary property address as one line: "STREET, CITY, PA ZIP".
  Combine the street and city/zip lines from the source.
- municipality: The municipality column value, e.g. "Pittsburgh", "Penn Hills",
  "Munhall", "Liberty", "Wilkinsburg". Keep capitalization as shown.
- parcelId: The Parcel/Tax ID. **Format: "DDDD-L-DDDDD"** — 1-4 digits, a
  hyphen, exactly ONE letter (A-Z), a hyphen, 1-5 digits. An optional 4th
  hyphen-segment of 1-6 digits may follow for sub-parcels. Examples:
  "556-G-276", "0033-B-00272", "174-K-322", "131-H-00229", "1269-D-75".
  Do NOT include the "Parcel/Tax ID:" label in the value. If you cannot
  read a parcel ID that cleanly matches this format, return null rather
  than guessing — do NOT invent letters or digits.
- soldFor: For results PDFs only — the SALE PRICE as a NUMBER (strip "$" and
  commas). Set it to the dollar amount shown in the status for "Third Party",
  "PLTF Overbid", and "PLTF Cost"/"PLTF Cost & Tax" outcomes. For "Money Made"
  use the number only if one is explicitly shown, else null. For "Postponed",
  "Stayed", "Active", or any non-sale status, use null.
  ⚠️ soldFor is NOT the same as openingBid. openingBid is the "Cost & Tax Bid"
  (the debt owed); soldFor is what the property actually sold for. They are
  different numbers — never copy one into the other.
- soldTo: The purchaser's name when one is named (e.g. the third-party bidder).
  For plaintiff overbid/cost outcomes the purchaser is effectively the
  plaintiff; name it if the source does, otherwise null. Null when not sold.

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
      "serviceOk": false,
      "serviceCheckedCount": 2,
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

/**
 * Repair prompt — used when validation flags one or more records from the
 * initial parse. Sent alongside the SAME PDF chunk and the list of bad
 * records. Designed to catch column-shift errors specifically.
 */
export const REPAIR_SYSTEM_PROMPT = `You are fixing a previous parser pass over an Allegheny County Sheriff's Sale PDF that produced records with format errors.

You will receive:
  - The original PDF chunk (as a document content block)
  - A JSON list of flagged records with their detected issues

Re-extract ONLY the flagged records, paying special attention to column alignment.

## Common column-shift mistakes to watch for

- "Plaintiff(s):" and "Attorney for the Plaintiff:" are COLUMN HEADERS, not values. Never include label text in a value.
- Plaintiff vs attorney:
  - Tax-lien sales: plaintiff is a municipal entity ("Munhall Borough", "Penn Hills School District", "City of Pittsburgh", "MUNHALL SANITARY SEWER MUN AUTH").
  - Mortgage foreclosure sales: plaintiff is a bank or servicer ("U.S. Bank Trust National Association", "Nationstar Mortgage LLC", "Wells Fargo Bank, N.A."). These contain "LLC"/"N.A."/"TRUST" and are STILL the plaintiff, not the attorney.
  - Attorneys are law firms — distinctive markers include "ESQ", "P.C.", "LAW GROUP", "LEGAL GROUP", "LEGAL TAX SERVICE", "& MAIELLO", "GOEHRING RUTTER & BOEHM", "KRATZENBERG & LAZZARO", "ANDREWS & PRICE", "LOGS LEGAL GROUP LLC". A bare "LLC" alone is NOT enough to mark a name as an attorney.
- Defendants are PEOPLE or estates — "Smith, John", "Unknown Heirs of Roberta J. Brock deceased", or sometimes companies like "Vision TCS Contracting".
- Opening bid is a multi-digit dollar amount, almost always $500+. A bid like "$94.17" almost certainly means digits were dropped from the front (real value probably "$8,104.17" or similar).
- Case numbers are "XX-YY-NNNNNN" — 2-letter prefix (GD/MG/AR/etc.), 2-digit year (12–26), 6-digit number. Common prefixes: GD = General Docket, MG = Mortgage.
- Parcel IDs are "D-L-D" — 1-4 digits, ONE letter, 1-5 digits, optional 4th -digits segment. Examples: "556-G-276", "174-K-322". Never two letters.
- The address line wraps in the PDF: it usually has a street number + street name on line 1 and "CITY, PA ZIP" on line 2. Combine these into one value.

## Match each repaired record to its original

Each input record includes its previous caseNumber and address (even if those were wrong). Match the right entry in the PDF by ADDRESS (most reliable) or street number when the original caseNumber was unreadable.

## Output

Return ONLY a JSON object, no prose, no markdown fences:

{
  "repairs": [
    {
      "originalCaseNumber": "GD-24-011176",
      "matchedByAddress": "7350 Bennett Street",
      "record": { /* full property record using the same schema as the main parse */ }
    }
  ]
}

If you cannot confidently re-extract a record (e.g., the address was also unreadable in the original), omit it from "repairs" rather than guess. Use null for individual fields you can't read, not invented values.`

export const REPAIR_USER_PROMPT = (flaggedRecords) =>
  `Please re-extract these ${flaggedRecords.length} flagged record${flaggedRecords.length === 1 ? '' : 's'} from the attached PDF chunk:\n\n` +
  JSON.stringify(flaggedRecords, null, 2)
