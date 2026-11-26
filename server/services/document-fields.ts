import { parseMoney } from "../../shared/domain.js";
function dateValue(raw: string) {
  const isoMatch = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const localMatch = raw.match(/\b(\d{2})[./-](\d{2})[./-](\d{4})\b/);
  const iso = isoMatch
    ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
    : localMatch
      ? `${localMatch[3]}-${localMatch[2]}-${localMatch[1]}`
      : undefined;
  return iso &&
    !isNaN(Date.parse(iso)) &&
    new Date(iso).toISOString().slice(0, 10) === iso
    ? iso
    : undefined;
}
const labels = {
  lastName: ["ТЕГІ", "ФАМИЛИЯ", "SURNAME"],
  firstName: ["АТЫ", "ИМЯ", "GIVEN NAMES", "GIVEN NAME", "FIRST NAME", "NAME"],
  middleName: ["ӘКЕСІНІҢ АТЫ", "ОТЧЕСТВО", "PATRONYMIC"],
  birthDate: [
    "ТУҒАН КҮНІ, АЙЫ, ЖЫЛЫ",
    "ТУҒАН КҮНІ",
    "ДАТА РОЖДЕНИЯ",
    "DATE OF BIRTH",
  ],
  iin: ["ЖСН", "ИИН", "IIN"],
  documentNumber: [
    "КУӘЛІК НӨМІРІ",
    "ҚҰЖАТ НӨМІРІ",
    "НОМЕР УДОСТОВЕРЕНИЯ",
    "НОМЕР ДОКУМЕНТА",
    "DOCUMENT NUMBER",
    "DOCUMENT NO",
  ],
  issuedBy: [
    "БЕРГЕН ОРГАН",
    "БЕРГЕН ОРГАНЫ",
    "ОРГАН ВЫДАЧИ",
    "КЕМ ВЫДАН",
    "ISSUED BY",
    "AUTHORITY",
  ],
  issueDate: ["БЕРІЛГЕН КҮНІ", "ДАТА ВЫДАЧИ", "DATE OF ISSUE"],
  expiryDate: [
    "ҚОЛДАНЫЛУ МЕРЗІМІ",
    "ЖАРАМДЫЛЫҚ МЕРЗІМІ",
    "ДЕЙСТВИТЕЛЕН ДО",
    "СРОК ДЕЙСТВИЯ",
    "DATE OF EXPIRY",
  ],
  amount: [
    "ТӨЛЕМ СОМАСЫ",
    "АУДАРЫМ СОМАСЫ",
    "СУММА ПЕРЕВОДА",
    "СУММА ПЛАТЕЖА",
    "СУММА",
    "СОМАСЫ",
    "ИТОГО",
    "TOTAL",
    "AMOUNT",
  ],
  paymentDate: [
    "КҮНІ МЕН УАҚЫТЫ",
    "ДАТА И ВРЕМЯ",
    "ДАТАИ ВРЕМЯ",
    "ДАТА ПЛАТЕЖА",
    "ДАТА ПЕРЕВОДА",
    "ТӨЛЕМ КҮНІ",
    "КҮНІ",
    "ДАТА",
    "DATE",
  ],
  recipientName: ["ПОЛУЧАТЕЛЬ", "АЛУШЫ", "RECIPIENT"],
  payerName: [
    "САТЫП АЛУШЫНЫҢ АТЫ-ЖӨНІ",
    "САТЫП АЛУШЫНЫҢ АТЫ ЖӨНІ",
    "ФИО ПОКУПАТЕЛЯ",
    "ОТПРАВИТЕЛЬ",
    "ПЛАТЕЛЬЩИК",
    "ТӨЛЕГЕН АДАМ",
    "ТӨЛЕУШІ",
    "ЖІБЕРУШІ",
    "PAYER",
    "SENDER",
  ],
  receiptNumber: [
    "№ КВИТАНЦИИ",
    "НОМЕР КВИТАНЦИИ",
    "НОМЕР ТРАНЗАКЦИИ",
    "НОМЕР ЧЕКА",
    "№ ЧЕКА",
    "ЧЕКТІҢ НӨМІРІ",
    "ЧЕК НӨМІРІ",
    "TRANSACTION NUMBER",
    "TRANSACTION ID",
    "RECEIPT NUMBER",
    "ЧЕК №",
    "КВИТАНЦИЯ №",
    "ТҮБІРТЕК НӨМІРІ",
    "ТҮБІРТЕК №",
  ],
  method: [
    "СПОСОБ ОПЛАТЫ",
    "ТӨЛЕМ ТӘСІЛІ",
    "PAYMENT METHOD",
    "ОПЛАЧЕНО",
    "ОТКУДА",
    "ҚАЙДАН",
    "КАЙДАН",
    "ТӨЛЕНДІ",
    "СПИСАНО С",
  ],
};
const prefix = (values: string[]) =>
  new RegExp("^(?:" + values.join("|") + ")(?=\\s|[:/|–—-]|$)", "iu");
const receiptHeadings = (
  [
    "amount",
    "paymentDate",
    "recipientName",
    "payerName",
    "receiptNumber",
    "method",
  ] as const
).map((field) => ({ field, heading: prefix(labels[field]) }));

export function receiptHeadingFields(line: string): string[] {
  const match = receiptHeadings.find(({ heading }) =>
    heading.test(line.trim()),
  );
  if (!match) return [];
  return match.field === "paymentDate"
    ? ["paymentDate", "paymentTime"]
    : [match.field];
}
const anyLabel = prefix(Object.values(labels).flat());
// Either language can remain readable when OCR damages the other half of a
// bilingual heading. Never use such a heading as the value of an empty name.
const identityExtraLabel = prefix([
  "ТУҒАН ЖЕРІ",
  "МЕСТО РОЖДЕНИЯ",
  "PLACE OF BIRTH",
  "ҰЛТЫ",
  "НАЦИОНАЛЬНОСТЬ",
  "NATIONALITY",
  "ЖЫНЫСЫ",
  "ПОЛ",
  "SEX",
]);
function isIdentityFieldLabel(value: string) {
  return value.split(/[/|]/).some((part) => {
    const text = part.trim();
    return (
      anyLabel.test(text) ||
      identityExtraLabel.test(text) ||
      /(?:^|\s)(?:КҮНІ|РОЖДЕНИЯ|МЕРЗІМІ)(?:\s|$)/iu.test(text)
    );
  });
}
export type PositionedText = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};
// Use the printed label's position to bind a native PDF value to its field.
// Native text preserves letters such as Ұ which image OCR may confuse with У.
export function extractIdentityLayout(
  values: PositionedText[],
  anchors: PositionedText[],
) {
  const result: Record<string, string | number> = {};
  for (const key of [
    "lastName",
    "firstName",
    "middleName",
    "birthDate",
    "iin",
    "documentNumber",
    "issuedBy",
    "issueDate",
    "expiryDate",
  ] as const) {
    const found: string[] = [];
    for (const anchor of anchors) {
      if (!prefix(labels[key]).test(anchor.text.trim())) continue;
      const height = Math.max(1, anchor.bbox.y1 - anchor.bbox.y0);
      const candidates = values
        .filter((value) => {
          const gap = value.bbox.y0 - anchor.bbox.y1;
          return (
            value.text.trim() &&
            !isIdentityFieldLabel(value.text.trim()) &&
            gap >= -height * 0.3 &&
            gap <= height * 5 &&
            Math.abs(value.bbox.x0 - anchor.bbox.x0) <= height * 2 &&
            ![...anchors, ...values].some(
              (other) =>
                other !== anchor &&
                isIdentityFieldLabel(other.text.trim()) &&
                other.bbox.y0 >= anchor.bbox.y1 &&
                other.bbox.y0 < value.bbox.y0 &&
                Math.abs(other.bbox.x0 - anchor.bbox.x0) <= height * 2,
            )
          );
        })
        .sort((a, b) => a.bbox.y0 - b.bbox.y0);
      // Ambiguous columns or several native fragments on the same line need manual review.
      if (
        !candidates.length ||
        (candidates[1] &&
          Math.abs(candidates[1].bbox.y0 - candidates[0].bbox.y0) < height)
      )
        continue;
      const value = candidates[0].text.trim();
      if (
        key.endsWith("Date")
          ? Boolean(dateValue(value))
          : key === "iin"
            ? /^\d{12}$/.test(value)
            : key === "documentNumber"
              ? /^[A-Za-zА-Яа-я0-9 -]{3,30}$/.test(value)
              : key === "issuedBy"
                ? value.length >= 3 && value.length <= 200
                : /^[\p{Script=Cyrillic}A-Za-z\s’'-]{2,100}$/u.test(value)
      )
        found.push(value);
    }
    if (new Set(found).size === 1) {
      Object.assign(
        result,
        extractFields(labels[key][0] + "\n" + found[0], "identity"),
      );
    }
  }
  return result;
}
export function machineReadableNames(text: string) {
  const matches = text
    .split(/\r?\n/)
    .map((line) =>
      line.includes("<<") ? line.replace(/\s/g, "") : line.trim(),
    )
    .filter((line) => line.length >= 25)
    .map((line) =>
      line.match(/^([A-Z]+(?:<[A-Z]+)*)<<([A-Z]+(?:<[A-Z]+)*)<{2,}$/),
    )
    .filter((match) => match !== null);
  if (matches.length !== 1) return {};
  return {
    lastNameLatin: matches[0][1].replaceAll("<", " "),
    firstNameLatin: matches[0][2].replaceAll("<", " "),
  };
}
export function receiptAmount(raw: string) {
  if (/^\s*[-−]/.test(raw)) return undefined;
  const matched = raw.match(/[-+]?\d(?:[\d\s.,'’]*\d)?/);
  if (!matched || matched[0].startsWith("-")) return undefined;
  let value = matched[0].replace(/[\s'’+]/g, "");
  const comma = value.lastIndexOf(","),
    dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".",
      group = decimal === "," ? "." : ",";
    const [whole, fraction, ...rest] = value.split(decimal);
    if (
      rest.length ||
      !/^\d{1,2}$/.test(fraction) ||
      !new RegExp("^\\d{1,3}(?:\\" + group + "\\d{3})+$").test(whole)
    )
      return undefined;
    value = whole.split(group).join("") + "." + fraction;
  } else if (comma >= 0 || dot >= 0) {
    const sep = comma >= 0 ? "," : ".",
      parts = value.split(sep);
    if (parts.length === 2 && /^\d{1,2}$/.test(parts[1]))
      value = parts[0] + "." + parts[1];
    else if (
      /^\d{1,3}$/.test(parts[0]) &&
      parts.slice(1).every((p) => /^\d{3}$/.test(p))
    )
      value = parts.join("");
    else return undefined;
  }
  try {
    return parseMoney(value);
  } catch {
    return undefined;
  }
}
function hasIdentityContext(text: string) {
  if (
    /ЖЕКЕ\s+КУ[ӘА]ЛІК|УДОСТОВЕРЕНИЕ\s+ЛИЧНОСТИ|IDENTITY\s+(?:CARD|DOCUMENT)/iu.test(
      text,
    )
  )
    return true;
  const hasBirthLabel = /ДАТА\s+РОЖДЕНИЯ|ТУҒАН\s+КҮНІ|DATE\s+OF\s+BIRTH/iu.test(
    text,
  );
  const hasNameLabel = /ТЕГІ|ФАМИЛИЯ|SURNAME|GIVEN\s+NAMES/iu.test(text);
  // Older cards have an unlabelled IIN above the machine-readable zone.
  // OCR can miss the faded title while retaining the birth label and KAZ row.
  const hasMachineRow = text
    .split(/\r?\n/)
    .some((line) =>
      /[A-Z0-9<]{5,}KAZ[A-Z0-9<]{10,}/.test(line.replace(/\s/g, "")),
    );
  return hasBirthLabel && (hasNameLabel || hasMachineRow);
}
export function isReceiptInsteadOfIdentity(text: string) {
  return (
    !hasIdentityContext(text) &&
    /Оплата совершена|Т[өео]лем жасалды|С[әа]тті аударылды|Перевод (?:успешно|выполнен)|Плат[её]ж выполнен/iu.test(
      text,
    ) &&
    /№\s*(?:чека|квитанции)|Түбіртек\s*№|ФИО\s+покупателя|ИИН\s*[/]\s*БИН/iu.test(
      text,
    )
  );
}
export function identityIinCandidates(text: string) {
  if (isReceiptInsteadOfIdentity(text)) return [];
  const lines = text
    .normalize("NFC")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = new Set<string>();
  const accept = (value: string) => {
    // Only printed digits and spaces. Never repair letters or invent digits.
    if (/^\d[\d \t\u00a0]*$/.test(value)) {
      const digits = value.replace(/\s/g, "");
      if (/^\d{12}$/.test(digits)) candidates.add(digits);
    }
  };
  // Mixed Kazakh/Latin OCR can read the IIN heading as «ІМ» or «ІІН».
  // Accept those heading shapes only within an established identity context.
  const label = hasIdentityContext(text)
    ? /^(?:ЖСН|ИИН|IIN|[IІl1|И]{1,3}[NИHМMН])(?=\s|[:/|–—-]|$)/iu
    : prefix(labels.iin);
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    let value = lines[i];
    while (label.test(value))
      value = value.replace(label, "").replace(/^[\s:/|]+/, "");
    let next = i + 1;
    if (!value) value = lines[next++] || "";
    if (/^\d[\d \t]*$/.test(value)) {
      while (
        value.replace(/\s/g, "").length < 12 &&
        next < lines.length &&
        /^\d[\d \t]*$/.test(lines[next])
      )
        value += " " + lines[next++];
    }
    accept(value);
  }
  if (hasIdentityContext(text)) for (const line of lines) accept(line);
  return [...candidates];
}
// The heading and date may be in different layers of a PDF. Only recover a
// complete date that was actually printed and agrees with the extracted IIN.
// In particular, the IIN alone supplies neither a date nor a guessed century.
export function printedBirthDate(
  sources: string[],
  fields: Record<string, string | number>,
) {
  const iin = fields.iin;
  if (typeof iin !== "string" || !/^\d{12}$/.test(iin)) return;
  const dates = new Set<string>();
  const otherDates = new Set([fields.issueDate, fields.expiryDate]);
  const validityLabel = prefix([...labels.issueDate, ...labels.expiryDate]);
  for (const source of sources) {
    const lines = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const [i, line] of lines.entries()) {
      const value = line.replace(/[ \t]*([./-])[ \t]*/g, "$1");
      if (!/^(?:\d{2}[./-]\d{2}[./-]\d{4}|\d{4}-\d{2}-\d{2})$/.test(value))
        continue;
      const date = dateValue(value);
      if (!date || date.slice(2).replaceAll("-", "") !== iin.slice(0, 6))
        continue;
      if (
        (lines[i - 1] || "")
          .split(/[/|]/)
          .some((part) => validityLabel.test(part.trim())) ||
        /^[-–—]$/.test(lines[i - 1] || "") ||
        /^[-–—]$/.test(lines[i + 1] || "")
      )
        otherDates.add(date);
      dates.add(date);
    }
  }
  for (const date of otherDates)
    if (typeof date === "string") dates.delete(date);
  if (dates.size === 1) return [...dates][0];
}
export function identityDetails(text: string) {
  const result: Record<string, string> = {};
  const iins = identityIinCandidates(text);
  if (iins.length === 1) result.iin = iins[0];
  if (!hasIdentityContext(text)) return result;
  const lines = text.split(/\r?\n/).map((v) => v.trim());
  for (const [key, length] of [["documentNumber", 9]] as const) {
    const values = [
      ...new Set(
        lines.filter((line) => new RegExp(`^\\d{${length}}$`).test(line)),
      ),
    ];
    if (values.length === 1) result[key] = values[0];
  }
  if (
    /БЕРІЛГЕН\s+КҮНІ|ДАТА\s+ВЫДАЧИ|ЖАРАМДЫЛЫҚ\s+МЕРЗІМІ|СРОК\s+ДЕЙСТВИЯ/iu.test(
      text,
    )
  ) {
    const ranges = [
      ...text.matchAll(
        /(\d{2}[./]\d{2}[./]\d{4})\s*[-–—]\s*(\d{2}[./]\d{2}[./]\d{4})/g,
      ),
    ];
    const unique = [...new Set(ranges.map((r) => r[1] + "|" + r[2]))];
    if (unique.length === 1) {
      const [a, b] = unique[0].split("|");
      const start = dateValue(a),
        end = dateValue(b);
      if (start && end && start <= end) {
        result.issueDate = start;
        result.expiryDate = end;
      }
    }
  }
  return result;
}
function normalizeReceiptLabels(text: string) {
  return text
    .replace(/(?:№|N[oо°]?\.?)[ \t]*(чека|квитанции)/giu, "№ $1")
    .replace(/№[ \t]*\n[ \t]*(чека|квитанции)/giu, "№ $1");
}
export function extractFields(text: string, kind: string) {
  if (kind === "receipt") text = normalizeReceiptLabels(text);
  else
    text = text.replace(
      /(\d{2})[ \t]*([./])[ \t]*(\d{2})[ \t]*([./])[ \t]*(\d{4})/g,
      "$1$2$3$4$5",
    );
  const lines = text
    .normalize("NFC")
    // Halyk wraps the label around the value in narrow receipt columns.
    .replace(/№\s*\n\s*(\d+)\s*\n\s*квитанции/giu, "№ квитанции $1")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  const fields: Record<string, string | number> = {};
  function labeled(aliases: string[], allowEmpty = false, dateField = false) {
    let foundEmpty = false;
    const expression = prefix(aliases);
    for (let i = 0; i < lines.length; i++) {
      let heading = lines[i];
      // A damaged Kazakh heading can still have a clear Russian label.
      if (kind === "identity" && !expression.test(heading)) {
        const parts = heading.split(/\s*[/|]\s*/);
        const labelIndex = parts.findIndex((part) => expression.test(part));
        if (labelIndex >= 0) heading = parts.slice(labelIndex).join(" / ");
      }
      if (!expression.test(heading)) continue;
      let value = heading.replace(expression, "").replace(/^[\s:/|]+/, "");
      // A bilingual heading is one label, never the person's name.
      while (expression.test(value))
        value = value.replace(expression, "").replace(/^[\s:/|]+/, "");
      if (!value) value = lines[i + 1] || "";
      if (dateField && /^[-–—]+$/.test(value)) value = lines[i + 2] || "";
      // Some receipts put timezone wording between the date label and value.
      if (/^(?:по Астане|Астана уақыты бойынша|\(Астана\))$/iu.test(value))
        value = lines[i + 2] || "";
      value = value.replace(/^по Астане\s*/iu, "");
      const isLabel =
        kind === "identity"
          ? isIdentityFieldLabel(value)
          : anyLabel.test(value);
      if (allowEmpty && (isLabel || /^[-–—]+$/.test(value))) {
        foundEmpty = true;
        continue;
      }
      if (value && !isLabel) return value.trim();
    }
    return foundEmpty ? "" : undefined;
  }
  if (kind === "identity") {
    Object.assign(fields, machineReadableNames(text), identityDetails(text));
    for (const key of ["lastName", "firstName", "middleName"] as const) {
      const value = labeled(labels[key], key === "middleName");
      if (key === "middleName" && value === "") fields.middleName = "";
      if (!value) continue;
      const chunks = value.split(/\s*[/|]\s*/);
      // Some IDs print the Cyrillic and Latin spelling on adjacent lines
      // under one bilingual heading rather than separating them with a slash.
      const valueIndex = lines.findIndex(
        (line) =>
          line === value ||
          (prefix(labels[key]).test(line) && line.endsWith(value)),
      );
      const next = valueIndex >= 0 ? lines[valueIndex + 1] : undefined;
      if (
        next &&
        !isIdentityFieldLabel(next) &&
        /^[\p{Script=Cyrillic}\s’'-]{2,100}$/u.test(value) &&
        /^[A-Za-z\s’'-]{2,100}$/.test(next)
      )
        chunks.push(next);
      const cyrillic = chunks.find((v) =>
        /^[\p{Script=Cyrillic}\s’'-]{2,100}$/u.test(v),
      );
      const latin = chunks.find((v) => /^[A-Za-z\s’'-]{2,100}$/.test(v));
      if (cyrillic) fields[key] = cyrillic;
      if (latin && key !== "middleName") fields[key + "Latin"] = latin;
    }
    // Separate English labels can coexist with Cyrillic labels on the same document.
    for (const [key, aliases] of [
      ["lastNameLatin", ["SURNAME"]],
      ["firstNameLatin", ["GIVEN NAMES", "GIVEN NAME", "FIRST NAME", "NAME"]],
    ] as const) {
      const value = labeled([...aliases]);
      if (value && /^[A-Za-z\s’'-]{2,100}$/.test(value)) fields[key] = value;
    }
    for (const key of [
      "documentNumber",
      "issuedBy",
      "issueDate",
      "expiryDate",
    ] as const) {
      const value = labeled(labels[key], false, key.endsWith("Date"));
      if (!value) continue;
      if (key.endsWith("Date")) {
        const dates =
          value.match(/\d{2}[./]\d{2}[./]\d{4}|\d{4}-\d{2}-\d{2}/g) || [];
        if (dates.length === 2) {
          const start = dateValue(dates[0]),
            end = dateValue(dates[1]);
          if (start && end && start <= end) {
            fields.issueDate = start;
            fields.expiryDate = end;
          }
        } else {
          const date = dateValue(value);
          if (date && !fields[key]) fields[key] = date;
        }
      } else if (key === "documentNumber") {
        const number = value.replace(/^№\s*/, "");
        if (/^[A-Za-zА-Яа-я0-9 -]{3,30}$/.test(number)) fields[key] = number;
      } else if (value.length >= 3 && value.length <= 200) fields[key] = value;
    }
    const birth = labeled(labels.birthDate, false, true);
    if (birth) {
      const date = dateValue(birth);
      if (date) fields.birthDate = date;
    }
  } else {
    const amount = labeled(labels.amount);
    if (amount) {
      const parsed = receiptAmount(amount);
      if (parsed !== undefined) fields.amount = parsed;
    }
    // Successful QR receipts show a standalone currency amount below the status.
    // Never use the merchant IIN, a card number, or an arbitrary unlabeled number.
    if (fields.amount === undefined) {
      const success = lines.findIndex((line) =>
        /^(?:Оплата совершена|Плат[её]ж выполнен|Перевод выполнен успешно|Перевод успешно соверш[её]н|Перевод успешно совер\.{3}|Т[өео]лем жасалды|Төлем сәтті орындалды|С[әа]тті аударылды)$/iu.test(
          line,
        ),
      );
      if (success >= 0) {
        const candidates = lines
          .slice(success + 1, success + 2)
          .filter((line) =>
            /^[\d\s.,'’]+\s*(?:₸|KZT|тенге|тг|Т|T)[.]?$/iu.test(line),
          );
        if (candidates.length === 1) {
          const amount = receiptAmount(candidates[0]);
          if (amount !== undefined) fields.amount = amount;
        }
      }
    }
    const date = labeled(labels.paymentDate);
    if (date) {
      const parsed = dateValue(date);
      if (parsed) fields.paymentDate = parsed;
    }
    // Bind time to the date block, including Kaspi's wrapped timezone line.
    for (let i = 0; i < lines.length; i++) {
      if (!prefix(labels.paymentDate).test(lines[i])) continue;
      const block = [lines[i]];
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        if (
          anyLabel.test(lines[j]) ||
          /^(?:Комиссия|Отправитель|Куда|Откуда|Сообщение)(?=\s|:|$)/iu.test(
            lines[j],
          )
        )
          break;
        block.push(lines[j]);
      }
      let value = block.join(" ");
      // In two-column transfers the date can sit just above the label baseline
      // and be returned first. Only accept an adjacent, complete date/time.
      if (
        !dateValue(value) &&
        /^\d{2}[./]\d{2}[./]\d{4}\s+\d{2}:\d{2}(?::\d{2})?$/.test(
          lines[i - 1] || "",
        )
      )
        value = lines[i - 1];
      const parsed = dateValue(value);
      if (!parsed) continue;
      fields.paymentDate = parsed;
      const time = value.match(/\b([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/);
      if (time) fields.paymentTime = time[0];
      break;
    }
    for (const key of ["recipientName"] as const) {
      const value = labeled(labels[key]);
      if (value)
        fields[key] = value.slice(0, key === "recipientName" ? 200 : 150);
    }
    const payer = labeled(labels.payerName);
    if (
      payer &&
      !/^(?:Комиссия|Откуда|Куда|Адрес|Сообщение|ИИН|БИН)(?=\s|:|$)/iu.test(
        payer,
      )
    ) {
      // Forwarded messages may append a comment after the printed initials.
      const name =
        payer.match(
          /^([\p{L}’'-]+(?:\s+[\p{L}’'-]+)*\s+[\p{L}]\.(?:\s*[\p{L}]\.)?)(?=\s|$)/u,
        )?.[1] || payer;
      if (/^[\p{L}\s.’'-]{2,200}$/u.test(name)) fields.payerName = name;
    }
    // Receipt identifiers are strings, including QR prefixes and leading zeros.
    // Join wrapped fragments only within the labelled number block.
    for (let i = 0; i < lines.length; i++) {
      if (!prefix(labels.receiptNumber).test(lines[i])) continue;
      let number = lines[i]
        .replace(prefix(labels.receiptNumber), "")
        .replace(/^[\s:#№]+/, "");
      let next = i + 1;
      if (!number) number = lines[next++] || "";
      if (/^(?:QR\s*)?[\d\s]+$/i.test(number) || /^QR$/i.test(number)) {
        number = number.replace(/\s/g, "");
        while (
          next < lines.length &&
          /^\d[\d ]*$/.test(lines[next]) &&
          number.length + lines[next].replace(/ /g, "").length <= 40
        )
          number += lines[next++].replace(/ /g, "");
      }
      if (
        /^[A-Za-z0-9][A-Za-z0-9_/-]{2,149}$/.test(number) &&
        /[\d_/-]/.test(number)
      )
        fields.receiptNumber = number;
      if (fields.receiptNumber) break;
    }
    if (!fields.receiptNumber) {
      const candidates = lines.filter((line) =>
        /^QR\s*\d[\d ]{5,39}$/i.test(line),
      );
      if (candidates.length === 1)
        fields.receiptNumber = candidates[0].replace(/\s/g, "").toUpperCase();
    }
    const source = labeled(labels.method);
    if (
      source &&
      (/[\p{L}]/u.test(source) || /^(?:[•●*·]{1,8}\s*)\d{4}$/u.test(source)) &&
      !/^(?:Адрес|Комиссия|Сообщение|ИИН|БИН)(?=\s|:|$)/iu.test(source)
    ) {
      let method = source;
      const sourceIndex = lines.findIndex(
        (line) =>
          line === source ||
          (prefix(labels.method).test(line) && line.endsWith(source)),
      );
      let next = sourceIndex + 1;
      if (
        /^с$/iu.test(method) &&
        /^(?:Kaspi|Каспи|Halyk)/iu.test(lines[next] || "")
      )
        method += " " + lines[next++];
      if (
        /^(?:с\s+)?(?:Kaspi|Каспи)$/iu.test(method) &&
        /^(?:Gold|GoId|Голд|Red|Ред|Pay|Депозит|Депозита)$/iu.test(
          lines[next] || "",
        )
      )
        method += " " + lines[next];
      method = method.replace(
        /(?:Kaspi|Каспи|Каspi)\s+(?:Gold|GoId|Gоld|Голд)/giu,
        "Kaspi Gold",
      );
      fields.method = method.slice(0, 100);
    }
    if (!fields.recipientName && fields.amount !== undefined) {
      const amountIndex = lines.findIndex(
        (line) =>
          /^[\d\s.,'’]+\s*(?:₸|KZT|тенге|тг|Т|T)[.]?$/iu.test(line) &&
          receiptAmount(line) === fields.amount,
      );
      const next = lines[amountIndex + 1] || "";
      if (amountIndex >= 0 && /^(?:ОО|ИП|ТОО|ЖК|ЖШС)\s/iu.test(next)) {
        const parts = [next];
        for (
          let i = amountIndex + 2;
          i < Math.min(lines.length, amountIndex + 4);
          i++
        ) {
          if (
            anyLabel.test(lines[i]) ||
            /^(?:№|ИИН|БИН|Комиссия|Тип перевода)/iu.test(lines[i])
          )
            break;
          parts.push(lines[i]);
        }
        fields.recipientName = parts.join(" ").slice(0, 200);
      } else if (
        amountIndex >= 0 &&
        /^[\p{L}’'-]+(?:\s+[\p{L}’'-]+)*\s+[\p{L}]\.(?:\s*[\p{L}]\.)?$/u.test(
          next,
        )
      ) {
        fields.recipientName = next;
      }
    }
  }
  if (
    kind === "receipt" &&
    !fields.recipientName &&
    /Оплата совершена|Т[өео]лем жасалды/iu.test(text)
  ) {
    const merchants = lines
      .map((line) => line.replace(/^[оoОO0]\s+(?=ИП|ТОО|ЖК|ЖШС)/u, ""))
      .filter((line) => /^(?:ИП|ТОО|ЖК|ЖШС)\s+.{2,190}$/u.test(line));
    if (merchants.length === 1) fields.recipientName = merchants[0];
  }
  if (kind === "receipt") {
    const recipient = String(fields.recipientName || "");
    if (/URSHYK|ҰРШЫҚ|УРШЫК/iu.test(recipient)) fields.receiptType = "urshyk";
    else if (
      /^[\p{L}’'-]+(?:\s+[\p{L}’'-]+)*\s+[\p{L}]\.(?:\s*[\p{L}]\.)?$/u.test(
        recipient,
      )
    )
      fields.receiptType = "personal";
  }
  return fields;
}

// WhatsApp can flatten a receipt into one line and prepend unrelated profile
// details. Rebuild labeled receipt lines without treating that preamble as money.
export function extractReceiptText(message: string) {
  message = normalizeReceiptLabels(message)
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
  const success =
    /Оплата совершена|Перевод выполнен успешно|Перевод успешно соверш[её]н|Плат[её]ж выполнен|Т[өео]лем жасалды|Төлем сәтті орындалды|С[әа]тті аударылды/giu;
  const matches = [...message.matchAll(success)];
  if (matches.length > 1)
    throw new Error("Бір уақытта бір чектің мәтінін ғана қойыңыз.");
  let text = matches.length
    ? message.slice(matches[0].index! + matches[0][0].length)
    : message;
  const headings = [
    ...labels.amount,
    ...labels.paymentDate,
    ...labels.receiptNumber,
    ...labels.recipientName,
    ...labels.payerName,
    ...labels.method,
    "ИИН/БИН продавца",
    "ФИО покупателя",
    "Комиссия",
    "Отправитель",
    "Откуда",
    "Куда",
    "Сообщение",
    "Адрес",
    "Тип перевода",
    "Аударым түрі",
  ]
    .sort((a, b) => b.length - a.length)
    .map((s) =>
      s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
    );
  text = text.replace(
    new RegExp(
      `(?<![\\p{L}\\p{N}])(${headings.join("|")})(?=\\s|[:/|–—-]|$)`,
      "giu",
    ),
    "\n$1 ",
  );
  if (matches.length) {
    text = text
      .trim()
      .replace(
        /^(\d[\d\s.,'’]*?\s*(?:₸|KZT|тенге|тг|Т|T)[.]?)(?=\s|$)\s*/iu,
        "$1\n",
      );
    text = matches[0][0] + "\n" + text;
  }
  return extractFields(text, "receipt");
}
