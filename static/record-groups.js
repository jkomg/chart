// Keep every patient-entered record distinct from the imported name-based summaries.
chart.groupClinicalByName = rows => {
  const imported = new Map();
  const manual = [];
  for (const row of [...rows].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    if (row._manual) {
      manual.push({ ...row, sources: [] });
      continue;
    }
    const key = row.name.toLowerCase();
    const existing = imported.get(key);
    imported.set(key, { ...row, sources: [...(existing?.sources || []), ...(row.document ? [row] : [])] });
  }
  return [...imported.values(), ...manual];
};
