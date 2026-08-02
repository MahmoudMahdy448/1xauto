import { existsSync, readFileSync } from 'fs';

export function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      const nextCharacter = line[index + 1];

      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }

  values.push(current.trim());
  return values;
}

export function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);

    return headers.reduce((row, header, index) => {
      row[header] = values[index] || '';
      return row;
    }, {});
  });
}

export function loadAccounts(csvFilePath) {
  if (!existsSync(csvFilePath)) {
    return [];
  }

  const csvText = readFileSync(csvFilePath, 'utf8');
  const rows = parseCsv(csvText);

  return rows
    .map((row) => ({
      username: row.username || row.email || '',
      password: row.password || '',
      surname: row.surname || ''
    }))
    .filter((account) => account.username && account.password);
}

export function getAccountsToProcess(csvFilePath) {
  const accountsFromCsv = loadAccounts(csvFilePath);

  if (accountsFromCsv.length > 0) {
    return accountsFromCsv;
  }

  return [
    {
      username: process.env.ONEXBET_USERNAME || '',
      password: process.env.ONEXBET_PASSWORD || '',
      surname: process.env.ONEXBET_SURNAME || ''
    }
  ];
}
