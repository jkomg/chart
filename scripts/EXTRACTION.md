# Extracting a source document

One JSON manifest per source document, written to `Data/extracted/<document stem>.json`. `chart_import.py manifest`
loads it into the account named by `person`, uploads the PDF, and links every value to its page.

Rules:

- **Transcribe; don't interpret.** Record what the document says. No diagnoses, risk statements, or
  "this suggests" that the document itself doesn't make. `summary` restates the document's own conclusions.
- **Every value carries `page`**, the 1-based page index in the PDF file (not the number printed on the page).
- **Dates are ISO** (`YYYY-MM-DD`). Labs use the collection date. If only a month is known, use the 1st and say so
  in `flags_for_review`.
- **Use null for unknowns.** Never guess a value, unit, or range. Put anything unreadable or ambiguous in
  `flags_for_review`.
- **Numbers are numbers.** `"value": 5.2`. Qualitative or censored results (`Negative`, `<0.5`, `1:160`, `>90`)
  go in `value_text` with `value: null`. For `<0.5`, also set `value_text` exactly as printed.
- **Image series** (CT/ultrasound/X-ray image pages) get a manifest with `kind: "imaging"`, a one-line summary, and
  no extracted values. Read only the first page.

```jsonc
{
  "document": "2022-12-10_invitae-connective-tissue-panel.pdf", // bucket filename: date_slug, [a-z0-9-_], .pdf
  "source_path": "Data/2022/14b. 10 Dec 2022 -- Invitae Connective Tissue Panel.pdf",
  "person": "mia",
  "patient_name_on_document": "as printed, for ownership checks (never imported)",
  "title": "Invitae Connective Tissue Disorders Panel",
  "date": "2022-12-10",
  "provider": "Invitae",            // lab, clinic, or company
  "clinician": "Dr. Name",          // ordering/treating clinician if shown, else null
  "kind": "lab",                    // lab | genetic | visit | er | imaging | monitor | sleep | other
  "summary": "1–3 factual sentences in plain language.",

  "labs": [{
    "test": "Vitamin D, 25-hydroxy",  // canonical name: common clinical name, consistent across labs
    "test_reported": "VITAMIN D,25-OH,TOTAL,IA", // exactly as printed
    "panel": "Vitamins",              // section/panel heading if shown
    "value": 41.0, "value_text": null, "unit": "ng/mL",
    "ref_low": 30, "ref_high": 100, "ref_text": "30-100",
    "flag": null,                     // high | low | abnormal | normal | null: only as marked by the lab
    "taken_at": "2023-09-13", "page": 4
  }],
  "measurements": [{                 // vitals; metric must be a key of vitals.METRICS
    "metric": "bp_systolic", "value": 112, "taken_at": "2022-01-07", "page": 1, "note": "seated"
  }],
  "events": [{                       // timeline entries for Medical history
    "date": "2022-01-07", "type": "diagnosis", // diagnosis | visit | er | procedure | imaging | test | hospitalization
    "title": "Diagnosed with POTS", "detail": "Cardiology visit; tilt-table findings.", "page": 2
  }],
  "diagnoses": [{ "name": "Postural orthostatic tachycardia syndrome", "icd10": "G90.A",
                  "date": "2022-01-07", "status": "active", "page": 2, "note": null }], // active | resolved | suspected | history
  "medications": [{ "name": "Propranolol", "dose": "10 mg", "schedule": "as needed",
                    "context": "prescribed", "date": "2022-01-07", "page": 3 }], // prescribed | current-list | discontinued
  "allergies": [{ "substance": "Penicillin", "reaction": "rash", "page": 1 }],
  "family_history": [{ "relation": "Mother", "condition": "Hypothyroidism", "page": 1 }],
  "genetic_findings": [{
    "test": "Connective tissue disorders panel", "gene": "COL5A1", "variant": "c.1234G>A", "protein": "p.Gly412Ser",
    "classification": "Uncertain significance", // Pathogenic | Likely pathogenic | Uncertain significance | Likely benign | Benign | Negative
    "zygosity": "heterozygous", "condition": "Ehlers-Danlos syndrome, classic type", "inheritance": "AD",
    "page": 2, "note": null
  }],
  "cycles": [{ "start": "2022-08-30", "end": null, "page": 1, "note": "LMP reported at visit" }],
  "flags_for_review": ["anything ambiguous, unreadable, or surprising"]
}
```

Omit empty arrays. A genetic test with no reportable variants gets one finding with `"classification": "Negative"`
and the genes tested in `note`.
