import "dotenv/config";
import mongoose from "mongoose";
import { connect, Participant, Payment, Finance } from "../server/models.js";
import { normalizeParticipant } from "../server/services/members.js";
import { REGIONS, today } from "../shared/domain.js";
if (process.env.NODE_ENV === "production")
  throw new Error("Synthetic seed is disabled in production.");
await connect();
if (await Participant.countDocuments())
  throw new Error(
    "Database contains participants; seed cancelled to preserve data.",
  );
const year = Number(today().slice(0, 4));
const surnames = [
  "Сынаққызы",
  "Үлгіұлы",
  "Мысалова",
  "Тестұлы",
  "Үлгіқызы",
  "Сынақов",
  "Мысалұлы",
  "Тестқызы",
];
const names = [
  "Айгүл",
  "Бекзат",
  "Меруерт",
  "Нұрлан",
  "Салтанат",
  "Ермек",
  "Әсел",
  "Дана",
  "Айсұлу",
  "Мұрат",
  "Гүлжан",
  "Самат",
];
const members = await Participant.insertMany(
  Array.from({ length: 84 }, (_, i) =>
    normalizeParticipant({
      lastName: surnames[i % surnames.length],
      firstName: names[i % names.length],
      middleName: "Үлгі дерек",
      lastNameLatin: "",
      firstNameLatin: "",
      birthDate: `${1950 + ((i * 7) % 57)}-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
      region: REGIONS[i % REGIONS.length],
      phone: `+7 000 000 ${String(i).padStart(4, "0")}`,
    }),
  ),
);
await Payment.insertMany(
  members
    .filter((_, i) => i % 5 !== 0)
    .map((p, i) => ({
      participantId: p._id,
      year,
      amount: i % 4 === 0 ? 109000 : i % 9 === 0 ? 700000 : 648700,
      paymentDate: `${year}-${String((i % 10) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
      recipientName: "Сынақ ұйымы — ойдан шығарылған",
      receiptNumber: `SYNTHETIC-${i}`,
      notes: "СИНТЕТИКАЛЫҚ СЫНАҚ ДЕРЕГІ",
      voidedAt: null,
    })),
);
await Finance.insertMany([
  {
    type: "income",
    amount: 5000000,
    date: `${year}-09-10`,
    category: "Сынақ түсімі",
    description: "Ойдан шығарылған жазба",
  },
  {
    type: "expense",
    amount: 1850000,
    date: `${year}-09-15`,
    category: "Жалдау ақысы",
    description: "Ойдан шығарылған жазба",
  },
  {
    type: "expense",
    amount: 320000,
    date: `${year}-10-12`,
    category: "Кеңсе заттары",
    description: "Ойдан шығарылған жазба",
  },
]);
console.info(
  "Created 84 synthetic participants, payments, and financial examples. No real personal data.",
);
await mongoose.disconnect();
