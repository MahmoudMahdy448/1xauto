import { existsSync, readdirSync } from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';

const screenshotsDir = path.resolve(process.cwd(), process.env.SCREENSHOTS_DIR || 'screenshots');

const files = existsSync(screenshotsDir)
  ? readdirSync(screenshotsDir).filter((f) => f.endsWith('.png'))
  : [];

const numbers = files
  .map((f) => {
    const match = f.match(/(01\d{9})/);
    return match ? match[1] : null;
  })
  .filter(Boolean);

const unique = [...new Set(numbers)];

if (unique.length === 0) {
  console.warn('No phone numbers found in screenshot filenames.');
  process.exit(1);
}

const excelData = unique.map((num) => ({ Phone: num }));
const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.json_to_sheet(excelData);
XLSX.utils.book_append_sheet(workbook, worksheet, 'Numbers');

const excelPath = process.env.EXCEL_FILE || path.resolve(process.cwd(), 'extracted_numbers.xlsx');
XLSX.writeFile(workbook, excelPath);
console.log(`Excel saved: ${excelPath} (${unique.length} unique numbers)`);
