# Бірлік — backend и локальный OCR

Express + TypeScript + MongoDB replica set, защищённые сессии, участники, годовые взносы, финансы, отчёты XLSX, private S3 и отдельный OCR worker. Frontend: [dkikowe/apa-front](https://github.com/dkikowe/apa-front).

## Локальный запуск

Нужны Node.js 22 LTS (22.13+) и Docker с Compose, либо MongoDB 8 replica set и S3-совместимое хранилище.

```sh
npm ci
npm run local:setup
# local:setup создаёт .env со случайными локальными секретами и .local/ACCESS.md.
docker compose up -d
npm run storage:init
npm run ocr:models
npm run admin:create
# Необязательно: только вымышленные данные и только в пустую базу.
npm run seed
npm run dev
```

API: http://127.0.0.1:3001/api/health. Frontend запускается отдельно на http://localhost:5173. `APP_ORIGIN` должен совпадать с origin frontend. `npm run dev` запускает API и OCR worker. Персональные документы не отправляются в сторонний OCR/AI API.

Локальная конфигурация — **только для синтетических данных**. MinIO без KMS использует `S3_ENCRYPTION=none`; production всегда отправляет документы с SSE-S3. `.env`, пароли, документы, базы и модели исключены из Git. Для MinIO без AWS PublicAccessBlock используется `S3_PROVIDER=minio`; инициализация проверяет отсутствие bucket policy. Уже существующая policy требует отдельного рассмотрения и не переписывается автоматически.

Без Docker: `npm run local:db` использует установленный `mongod`; `npm run local:storage` требует самостоятельно установленный официальный бинарник `.local/bin/minio`. Бинарники и готовые данные в репозиторий не входят.

## Проверки

```sh
npm run typecheck
npm run lint
npm run build
npm test
# Настоящее OCR, включая казахский/русский/английский текст:
npm run ocr:models
RUN_OCR_TESTS=1 npm test
```

`mongodb-memory-server` создаёт отдельную временную базу. При установленном mongod можно использовать `MONGOMS_SYSTEM_BINARY=/путь/к/mongod MONGOMS_VERSION=8.0.4 RUN_OCR_TESTS=1 npm test`. Реальная рабочая база не очищается.

Полный набор — **53 теста**. Без `RUN_OCR_TESTS=1` пропускаются восемь тестов распознавания изображений, остальные выполняются. Проверяются частичная оплата, переплата, отдельные годы, отмена/изменение, архив/восстановление, дубликаты и гонки, фильтры, полный Excel, доступ и CSRF, чтение PDF, корректное распознавание разделителей суммы и отсутствие выдуманных полей.

При работающих локальных API/S3/worker: `npm run test:integrations` проверяет сквозную загрузку вымышленного чека, OCR, приватный оригинал, платёж и дубликат. Скрипт создаёт синтетические записи; production запрещён. `node --import tsx scripts/verify-pdf-scan.ts` проверяет растровый PDF. Контрольный прогон 20 000 участников: `MONGOMS_SYSTEM_BINARY=/путь/к/mongod node --import tsx scripts/benchmark.ts`.

## OCR и его ограничения

PDF сначала читается локальным PDF.js. Если текстовый слой не содержит узнаваемых полей (например, это только колонтитул скана), страница отрисовывается и проходит Tesseract. PNG и JPEG также читаются локально. Поддержаны `kaz+rus+eng`, до 15 МБ и 10 страниц PDF.

Извлекаются подписанные поля. Сохраняется исходное латинское написание; транслитерация не выдумывается. Подписи соседних полей не выдаются за имена, суммы с разделителями проверяются. Если документ пустой/нечитаемый либо формат незнакомый, оператор получает ручной ввод. Точность для любых фото и любых банков не гарантируется; распознанные данные необходимо проверить. OCR чека не подтверждает поступление денег в банк.

## Production

```sh
npm ci
npm run build
NODE_ENV=production SERVE_FRONTEND=false npm start
NODE_ENV=production npm run start:worker
```

Настройте `.env` по `.env.example`: `APP_ORIGIN` (HTTPS frontend), `SESSION_SECRET`, защищённый MongoDB replica set, private S3 endpoint/region/bucket, шифрование. API в контейнере требует `HOST=0.0.0.0`; на хосте можно оставить loopback за reverse proxy. В репозитории отсутствуют production credentials и опубликованный сервис.

Dockerfile собирает сервер и скачивает только публичные OCR-модели. API и worker — два процесса/сервиса из одного образа; worker запускается `node dist/server/worker.js`. Модели в образе находятся в `/app/tessdata`. Для создания первого администратора в production-образе задайте `ADMIN_USERNAME` и `ADMIN_PASSWORD` (12+ символов) и выполните `npm run admin:create:prod`. Для сброса требуется `RESET_ADMIN_PASSWORD=true`; действующие сессии отзываются. Пароль не выводится в лог.

Перед реальными удостоверениями нужны согласованное место обработки/хранения, TLS, шифрование, резервное копирование с проверкой восстановления, ограниченные права S3 и проверка качества OCR на разрешённых контрольных документах. По умолчанию нельзя считать зарубежный AWS-регион подходящим.

## API

Все пути `/api`, кроме `/auth/login` и `/health`, защищены сессией. Для записи требуется `x-csrf-token` из `/auth/login` или `/auth/me`; чужой Origin отклоняется.

| Путь | Методы / назначение |
|---|---|
| `/auth/login`, `/auth/logout`, `/auth/me` | POST, POST, GET |
| `/participants` | GET: серверная пагинация/фильтры; POST: создание |
| `/participants/:id` | GET: карточка с историей; PATCH: изменение |
| `/participants/:id/archive` | POST: архив; `{restore:true}` возвращает |
| `/participants/:id/payments` | POST: взнос |
| `/payments/:id`, `/payments/:id/void` | PATCH: исправление; POST: отмена |
| `/documents` | POST multipart: `file`, `kind=identity/receipt` |
| `/documents/:id`, `/documents/:id/url` | GET: результат OCR / приватный URL на 120 секунд |
| `/documents/:id/retry` | POST: повтор OCR после ошибки, до 3 попыток |
| `/finance`, `/finance/:id` | GET/POST; PATCH/DELETE |
| `/statistics` | GET: агрегаты и графики |
| `/reports/:type` | GET: XLSX; members/payments/income/expense/financial |
| `/settings` | GET: правила учёта |

Суммы — целые тиыны. Год взноса (`year`) и календарная дата поступления (`paymentDate`) учитываются раздельно. Удаление/отмена не стирает аудит и финансовую историю. Общая финансовая статистика включает деньги архивных участников и не распределяется искусственно по возрастам/регионам.
