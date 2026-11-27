import { createCanvas } from "@napi-rs/canvas";
import type ExcelJS from "exceljs";

const excelWidthInPixels = 7; // Width of a digit in the workbook's Normal style.
const currency = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function prepareCompactLayout(
  sheet: ExcelJS.Worksheet,
  options: {
    incomeBreakdown?: boolean;
    largestNumber?: number;
    moneyWidths?: Record<string, number>;
  } = {},
) {
  const context = createCanvas(1, 1).getContext("2d");
  function selectFont(size: number, bold = false) {
    context.font = `${bold ? "bold " : ""}${(size * 96) / 72}px Calibri, Arial, "Liberation Sans", sans-serif`;
  }
  const widthOf = (text: string) => context.measureText(text).width;
  function ensureWidth(column: ExcelJS.Column, text: string) {
    const needed = Math.ceil((widthOf(text) + 8) / excelWidthInPixels);
    column.width = Math.max(column.width ?? 0, needed);
  }
  function lineCount(width: number, text: string, filter = false) {
    const available = Math.max(
      12,
      width * excelWidthInPixels - (filter ? 24 : 7),
    );
    const space = widthOf(" ");
    let lines = 0;
    for (const paragraph of text.split("\n")) {
      lines++;
      let used = 0;
      for (const word of paragraph.split(/[ \t]+/).filter(Boolean)) {
        const width = widthOf(word);
        if (used && used + space + width > available) {
          lines++;
          used = 0;
        }
        const extra = Math.max(0, Math.ceil(width / available) - 1);
        lines += extra;
        used = (used ? used + space : 0) + width - extra * available;
      }
    }
    return lines;
  }

  const headerRow = sheet.lastRow!.number;
  if (options.incomeBreakdown) sheet.getRow(4).height = 22;
  selectFont(13);
  if (options.largestNumber !== undefined)
    ensureWidth(
      sheet.getColumn("registrationNumber"),
      String(options.largestNumber),
    );
  for (const [key, value] of Object.entries(options.moneyWidths ?? {}))
    ensureWidth(sheet.getColumn(key), currency.format(value));

  // The age and date columns also hold money in the income summary.
  // Reserve room for the formatted figures before measuring any wrapped labels.
  for (let n = 3; n < headerRow; n++) {
    if (options.incomeBreakdown && n === 4) continue;
    const row = sheet.getRow(n);
    selectFont(n === 3 ? 14 : 13, true);
    row.eachCell((cell, index) => {
      cell.alignment = { ...cell.alignment, indent: 0 };
      if (typeof cell.value === "number")
        ensureWidth(sheet.getColumn(index), currency.format(cell.value));
    });
  }
  for (let n = 3; n <= headerRow; n++) {
    if (options.incomeBreakdown && n === 4) continue;
    const size = n === 3 ? 14 : 13;
    selectFont(size, n === 3 || n === headerRow);
    const row = sheet.getRow(n);
    let lines = 1;
    row.eachCell((cell, index) => {
      if (typeof cell.value === "string")
        lines = Math.max(
          lines,
          lineCount(
            sheet.getColumn(index).width ?? 10,
            cell.value,
            n === headerRow,
          ),
        );
    });
    row.height = Math.min(409, lines * (size + 4) + (n === headerRow ? 6 : 4));
  }

  const tableWidth = sheet.columns.reduce(
    (sum, column) => sum + (column.width ?? 10),
    0,
  );
  selectFont(19, true);
  sheet.getCell("A1").alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(1).height = Math.max(
    28,
    lineCount(tableWidth, sheet.getCell("A1").text) * 23 + 4,
  );
  selectFont(13);
  sheet.getRow(2).height = Math.max(
    22,
    lineCount(tableWidth, sheet.getCell("A2").text) * 17 + 3,
  );

  return (key: string | number, text: string) =>
    lineCount(sheet.getColumn(key).width ?? 10, text);
}

export function compactRowLines(
  row: ExcelJS.Row,
  countLines: ReturnType<typeof prepareCompactLayout>,
) {
  let lines = 1;
  row.eachCell((cell, column) => {
    if (typeof cell.value === "string")
      lines = Math.max(lines, countLines(column, cell.value));
  });
  return lines;
}

export const compactRowHeight = (lines: number) =>
  Math.min(409, lines * 17 + 3);
