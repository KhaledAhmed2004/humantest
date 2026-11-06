# Business Logic Discovery — plan (AI ছাড়া)

**লক্ষ্য:** user শুধু flow টা `.ht`-এ সাধারণ ভাষায় লিখবে। Test চলার সময় HumanTest নিজেই দেখবে ওই flow-এ frontend আর backend-এর কোন code চলেছে। সেখান থেকে business rules বের করে মানুষের ভাষায় দেখাবে। পরে code বদলালে সেটাও নিজে ধরবে, user-কে flow আবার লিখতে হবে না।

**মূল নিয়ম:**

- **কোনো AI/LLM থাকবে না।** সব কাজ হবে TypeScript compiler API দিয়ে code পড়ে (AST), পরিচিত pattern খুঁজে, template দিয়ে লিখে। ঠিক যেভাবে [src/humanize.ts](../src/humanize.ts) কাজ করে। একই code থেকে প্রতিবার হুবহু একই output আসবে।
- **শুধু সেই code পড়া হবে যেটা flow চলার সময় সত্যিই চলেছে।** Runtime যে API call record করে, সেখান থেকেই শুরু। পুরো codebase scan করা হবে না।
- **Rules structured data হিসেবে রাখা হবে, লেখা হিসেবে না।** মানুষের ভাষার লেখাটা আসবে একদম শেষে, render করার সময়। তাই change detection কাজ করবে data-র উপর, শব্দের উপর না।
- **নতুন dependency লাগবে না।** `typescript` আগেই devDependency হিসেবে আছে। এটা tsconfig-এর path alias (`@/hooks`), barrel file আর import নিজেই resolve করতে পারে।

**Pilot app:** `../full-stack/cp-bryen-fullStack` ("Island Hop" ferry booking)

| অংশ | যা দিয়ে বানানো |
| --- | --- |
| Backend | Express 4, Prisma 6 (PostgreSQL), Zod 4 + `validateRequest(...)`, `ApiError`, `auth(...roles)`, modules `src/app/modules/<name>/<name>.{route,controller,service,validation}.ts`, `/api/v1` prefix |
| Frontend | Next 16 App Router, React 19, axios (`src/lib/api.ts`) + React Query hooks (`src/hooks/use-*.ts`), Zod 3, react-hook-form, `toast.error` guard |

**প্রথম flow:** *Admin একটা Route বানায়।* এটা ছোট flow, কিন্তু এতে frontend validation, backend auth, Zod validation, service rules আর DB write, সব আছে:

- UI: `dashboard/admin/routes/_components/RouteFormModal.tsx`
- Hook: `useCreateRouteMutation` → `post("/routes")`
- Backend: `POST /api/v1/routes` → `auth(ADMIN)` → `RouteValidation.createRouteZodSchema` → `route.service.ts createRoute`

**দ্বিতীয় flow:** *Customer trip search করে booking দেয়।* এটা অনেক বড় flow: transaction, seat guard, fare।

---

## অগ্রগতি

| Phase | অবস্থা |
| --- | --- |
| 0 — Pilot setup | ✅ হয়েছে (2026-11-06)। `pilots/island-hop/`, `login.tokenCookie`, `apiHosts` guard। 2026-11-07: `upload` step যোগ হয়েছে, তাই এখন একটা test আসলেই route save করে আবার মুছে দেয় (`Start with: no test routes` আগের ব্যর্থ run-এর ফেলে যাওয়া route মোছে, শুধু নিজের marker description দেখে)। প্রতিটা user প্রতি run-এ একবার login করে, কারণ Island Hop মিনিটে ৫টার বেশি login নেয় না। |
| 1 — Step trace | ✅ হয়েছে (2026-11-06)। `.humantest/traces/<test>.json`, reporter → UI-র step-এর নিচে server calls। Plan থেকে একটা পরিবর্তন: call জোড়া হয় সর্বশেষ *action* step-এর সাথে, কারণ page load-এর data fetch আসে পরের "should see" step চলার সময়। |
| 2c — Frontend locator | ✅ হয়েছে (2026-11-06)। 2026-11-07: upload step-এর জন্যও (file input খোঁজে লেখার পাশে, বা যে component-এ লেখাটা দেওয়া হয়েছে তার ভেতরে; `accept` আর `onChange`-এর guard), data দিয়ে বানানো menu item (`{ label: 'Delete route', onSelect }`), আর handler যে নিজের function ডাকে সেগুলোর guard-ও। Click step-এর লেখা ধরে page-এর component-এ আসল button খোঁজা হয় (Next App Router: page URL থেকে `page.tsx`, তারপর import অনুসরণ করে, page-এর নিজের folder আগে)। এতে extractor 6-ও হয়েছে: `disabled`, handler-এর `toast.error` + `return` guard, HTML-এর `required`/`min`/`maxLength`, আর `zodResolver` schema। Baseline-এ click গুলোও আছে (`CLICK "…" on <page>`), তাই frontend-এর পরিবর্তনও ধরা পড়ে। পুরোনো baseline (frontend ছাড়া) ভুয়া "changed" দেখায় না। আর মুছে ফেলা বা নাম বদলানো test-এর trace আপনা থেকে মুছে যায়, baseline সরে `--accept`-এ। |
| 2 — Code locator | Backend ✅ হয়েছে (2026-11-06): 2a, 2b, 2d। Island Hop-এর 210টা route-ই পড়া গেছে, আর `unresolved` 0। Plan-এর বাইরে যা লাগল: route-এর ভেতরে লেখা inline handler; `XService = { … }` ধরনের export map follow না করা (নাহলে পুরো service file চলে আসে); `shared/` আর middleware-এর ভেতরে না ঢোকা; hash token থেকে বানানো (printer comment রেখে দিত)। Frontend (2c) plan-এর ক্রম মেনে Phase 4-এর পরে হবে। |
| 3 — Rule extractor | Extractor 1–3 ✅ হয়েছে (2026-11-06): access, Zod, throw। সাথে condition humanizer, English renderer, `discover` command, আর UI-র "Business logic" panel। Island Hop-এর 210টা route-এ 1977টা rule পাওয়া গেছে, কোনো crash নেই; condition-ওয়ালা rule-এর 92% English-এ, বাকিগুলো code হিসেবে দেখানো। `npm test` আর UI-র run, দুটোর পরেই discovery আপনা থেকে চলে। একটা সীমাবদ্ধতা: "checked" বিচার হয় message মিলিয়ে, তাই একই message-ওয়ালা দুটো throw (যেমন দুই জায়গার "Invalid credentials") দুটোই checked দেখায়। Extractor 4–5 ✅ হয়েছে (2026-11-07), নিচের সারিতে। |
| 3 — Extractor 4–5 | ✅ হয়েছে (2026-11-07)। নতুন দুই ধরনের rule: **What it changes** (Prisma `create/update/delete/…Many/upsert`, কোন field কী হয়: `decrement` = "goes down by", `?? ACTIVE` = "ACTIVE unless given"; `EmailService.sendEmail`-এর subject; socket `emit`; `stripe.*`) আর **The answer when all is well** (`sendResponse`-এর status আর message, যা `should see` দিয়ে ✔ হয়)। প্রতিটার সাথে তার শর্ত: if/else, early `return`-এর আগের guard, আর ডাকা function-এ পৌঁছানোর পথের শর্ত (call site থেকে)। `catch`-এ গিলে ফেলা ব্যর্থতা: "If that fails, the request still goes on"। লম্বা শর্ত: শেষ ৩টা বলা হয়, বাকিগুলো গোনা হয় (data-তে সব থাকে)। এর সাথে slice-এর একটা ভুল ঠিক হয়েছে: `EmailService = { sendEmail: async () => … }`-এর মতো object-এ পুরো object না, শুধু ডাকা method আসে (এতে 20টা ভুয়া refusal বাদ গেছে)। Island Hop: 210 route, 2417 rule, 250 effect, 0 crash; condition-ওয়ালা rule-এর 93% English-এ। বাকি: `$transaction`-এর "সব একসাথে, নয়তো কিছুই না" আলাদা করে বলা, আর Mongoose-এর write। |
| 4 — Change detection | ✅ হয়েছে (2026-11-06)। Baseline থাকে test project-এর `e2e/logic/`-এ (commit করার মতো, কারণ `.humantest/` gitignore করা)। প্রথম run-এ baseline আপনা থেকে save হয়। `discover --changes`, `--check` (CI-তে exit 1), `--accept`। UI server backend folder watch করে: file save করার মোটামুটি 6 সেকেন্ড পরে "Logic changed" দেখায়, সাথে Accept button। Backend-এর একটা sandbox কপিতে যাচাই করা হয়েছে: শুধু logic পরিবর্তন ধরা পড়ে, comment বা formatting ধরা পড়ে না, flow-এর বাইরের file-ও না। Rule যোগ বা মুছে ফেলা, route-এর path বদলানো, আর git-এর "কে, কবে বদলেছে" তথ্যও কাজ করছে। |

## Phase 0 — Pilot setup (পূর্বশর্ত)

**উদ্দেশ্য:** Island Hop-এ আজকের HumanTest দিয়েই একটা `.ht` test pass করানো।

1. `pilots/island-hop/` folder বানানো, তার ভেতরে `humantest.config.json`, `e2e/tests`, `e2e/states`:
   ```json
   {
     "name": "Island Hop",
     "baseURL": "http://localhost:3000",
     "apiPrefix": "/api/v1",
     "login": { "endpoint": "http://localhost:5000/api/v1/auth/login", "tokenCookie": { "name": "accessToken", "from": "data.accessToken" } },
     "users": { "admin": { "email": "...", "password": "..." } },
     "pages": { "routes page": "/dashboard/admin/routes" },
     "source": { "backend": "../../../full-stack/cp-bryen-fullStack/backend",
                 "frontend": "../../../full-stack/cp-bryen-fullStack/frontend" }
   }
   ```
2. **Runtime-এ ছোট পরিবর্তন: `login.tokenCookie`।** আজকের login ধরে নেয় যে server নিজেই cookie set করবে ([src/runtime/index.ts:128-140](../src/runtime/index.ts#L128-L140))। Island Hop token দেয় JSON-এ, আর frontend নিজে `accessToken` cookie বানায়। নতুন option টা থাকলে runtime reply-এর `from` path থেকে token নেবে, তারপর `context.addCookies` দিয়ে `baseURL`-এর domain-এ cookie বসাবে।
3. **`Start with: fresh data` state।** এটা backend-এর `npm run seed:fresh`, অথবা API দিয়ে দুটো port বানানো।
4. **⚠ Environment সাবধানতা।** `frontend/.env.local` এখন remote host (`nayem5000.binarybards.online`)-এর দিকে point করা। Test চালানোর আগে অবশ্যই `NEXT_PUBLIC_API_URL=http://localhost:5000/api/v1` দিতে হবে, নাহলে test গিয়ে remote server-এর data বদলে দেবে। Config-এ একটা guard থাকবে: API host `localhost` না হলে run শুরু হওয়ার আগেই থেমে যাবে।
5. Seed-এর credential (`admin@elineuque.com`) আর e2e-এর default credential মেলে না। কোনটা ব্যবহার হবে সেটা config-এ লিখে রাখতে হবে।

**কাজ শেষ ধরা হবে যখন:** `create-route.ht` (admin route বানায়, same-port error দেখে, তারপর সফল হয়) pass করে।

---

## Phase 1 — Step trace: প্রতিটা step কোন server call করেছে

**উদ্দেশ্য:** প্রতিটা run-এর পর, প্রতিটা test-এর জন্য একটা trace file লেখা। Report আর UI-তে প্রতিটা step-এর নিচে তার API call গুলো দেখানো।

**এখনকার অবস্থা:** `User.log`-এ প্রতিটা request-এর সাথে `line` আগে থেকেই রাখা হয় ([src/runtime/index.ts:346-349](../src/runtime/index.ts#L346-L349))। কিন্তু দুটো ঘাটতি আছে:

- এটা disk-এ লেখা হয় শুধু video বানানোর সময়।
- Query string বাদ পড়ে যায়, শুধু `pathname` রাখা হয়।

**কাজ:**

1. `LogEntry`-তে নতুন field যোগ: `query` (শুধু key, value না), `bodyKeys` (request body-র top-level key), আর `pageUrl` (request-এর সময় page কোন URL-এ ছিল)। Value রাখা হবে না, যাতে কোনো personal data file-এ না যায়।
2. `Scenario.finish()` প্রতিবার `.humantest/traces/<test-slug>.json` লিখবে, video থাকুক বা না থাকুক:
   ```json
   { "test": "...", "source": "create-route.ht:4", "status": "passed",
     "steps": [{ "line": 9, "user": "admin", "text": "click \"Create Route\"", "status": "passed",
                 "pageUrl": "/dashboard/admin/routes",
                 "requests": [{ "method": "POST", "path": "/api/v1/routes", "status": 201, "bodyKeys": ["departurePortId","destinationPortId"] }] }] }
   ```
3. Annotation `trace` যোগ হবে। Reporter-এর `test-end` event-এ `trace` path যাবে, সেখান থেকে UI server-এর `history.json`, সেখান থেকে UI।
4. UI-র step list ([ui/src/components/step-list.tsx](../ui/src/components/step-list.tsx))-এ প্রতিটা step-এর নিচে একটা ছোট "Server calls" লাইন: `POST /api/v1/routes → 201 Created`। Status-এর লেখা আসবে `humanize.ts`-এর `STATUS` table থেকে।

**কাজ শেষ ধরা হবে যখন:** demo mode ছাড়া চালালেও trace file তৈরি হয়, আর UI-তে "Create Route" step-এর নিচে `POST /api/v1/routes → 201` দেখা যায়।

**আকার:** ছোট। নতুন code-এর বেশিরভাগ runtime আর UI-তে।

---

## Phase 2 — Code locator: API call আর click থেকে আসল code

**উদ্দেশ্য:** trace-এর প্রতিটা step-এর জন্য একটা "code slice" বের করা, মানে ওই step চলার সময় যে function গুলো চলেছে তার তালিকা। এখানে কোনো অনুবাদ হবে না, শুধু খোঁজা।

নতুন folder `src/discovery/`। দুটো আলাদা TypeScript `Program` তৈরি হবে, backend আর frontend-এর নিজের নিজের tsconfig দিয়ে।

### 2a. Backend route table (`discovery/backend/routes.ts`)

Express app থেকে static ভাবে route table বানানো:

- `app.ts` থেকে `app.use('/api/v1', router)`।
- `routes/index.ts`-এর static array `[{ path, route }]` আর তার উপর `forEach(... router.use(...))`।
- Route file গুলোর ভেতরে nested `router.use('/ferries', FerryRoutes)`, যেমন `operator.route.ts`, `admin.route.ts`।
- প্রতিটা `router.<verb>(path, ...middlewares, Controller.fn)`। এখানে শেষ argument হলো handler, আর তার আগের সবগুলো middleware।
- **যেগুলো সামলাতে হবে:**
  - একই router একাধিক prefix-এ mount করা (`/schedules` আর `/trips`)।
  - Route declare করার ক্রম, কারণ Express প্রথম match নেয়। যেমন `/my` declare হয় `/:reference`-এর আগে।
  - `:param` segment।

Output হবে `{ method, pattern, middlewares[], handler, file, line }`-এর একটা list, declare করার ক্রমে। Recorded `POST /api/v1/routes` মেলানো হবে Express-এর নিয়মেই: list-এ প্রথম যেটা match করে।

### 2b. Backend call graph (`discovery/backend/slice.ts`)

Handler থেকে শুরু করে TypeChecker দিয়ে প্রতিটা call-এর declaration খুঁজে নিচে নামা:

- **ধাপগুলো:** controller → service → helper (`booking.seats.ts`, `serviceHelpers.ts`, অন্য module-এর service)।
- **কোথায় থামবে:** source root-এর বাইরে গেলে (`node_modules`, `@prisma/client`), অথবা depth ৫ পার হলে।
- **Middleware:** `auth(...)`, `validateRequest(schema)`, `fileHandler(...)` আলাদা ভাবে চিহ্নিত হবে। এদের argument (role, schema) পরের phase-এর জন্য রেখে দেওয়া হবে।
- **প্রতিটা function-এর জন্য রাখা হবে:** `{ file, name, range, role, hash }`। এখানে `role` হলো route, middleware, validation, controller, service বা helper। আর `hash` হলো AST-এর normalized text-এর sha1 (comment আর whitespace বাদ দিয়ে)।

### 2c. Frontend locator (`discovery/frontend/locate.ts`)

React 19-এ `_debugSource` আর নেই। তাই runtime hack না করে static ভাবে তিনটা সূত্র মেলানো হবে:

1. **Page URL থেকে page file।** `pageUrl` মেলানো হবে `src/app/**/page.tsx`-এর সাথে। এর জন্য `(group)` segment বাদ দিতে হবে, আর `[param]` segment যেকোনো value-এর সাথে মিলবে।
2. **API path থেকে hook।** `src/hooks/use-*.ts`-এ `get/post/patch/put/del(...)` call খোঁজা হবে, যাদের প্রথম argument string বা template literal। Base URL-এ `/api/v1` আগে থেকেই আছে, তাই সেটা বাদ দিয়ে মেলাতে হবে। এভাবে `useCreateRouteMutation` পাওয়া যাবে।
3. **Step-এর label থেকে component।** Step-এর quoted লেখা, যেমন `"Create Route"`, খোঁজা হবে page file থেকে transitively import হওয়া component-গুলোর JSX text আর string literal-এ। এভাবে `RouteFormModal.tsx:<line>` পাওয়া যাবে। ওই component যে hook ব্যবহার করে সেটা 2-এর ফলের সাথে মিলিয়ে দেখা হবে।

### 2d. CLI

`npm run ht -- locate "POST /api/v1/routes"` আর `npm run ht -- locate --trace <file>` code slice টা পড়ার মতো করে print করবে। Debug করার জন্য এটা জরুরি।

**কাজ শেষ ধরা হবে যখন:** `locate "POST /api/v1/routes"` দেখায়:

- `route.route.ts`-এর ঠিক line
- `auth(ADMIN)`
- `RouteValidation.createRouteZodSchema`
- controller আর `route.service.ts createRoute`
- frontend-এ `RouteFormModal.tsx` আর `use-routes.ts`

একটা দ্বিতীয় পরীক্ষা: `GET /api/v1/operator/schedules/<uuid>`। এটা nested router পেরিয়ে `ScheduleRoutes`-এ পৌঁছাতে হবে।

**আকার:** সবচেয়ে বড় আর সবচেয়ে ঝুঁকির phase। যা resolve করা যাবে না (dynamic route, computed path), সেটা বাদ যাবে না। তালিকায় "unresolved" লিখে থাকবে।

---

## Phase 3 — Rule extractor আর মানুষের ভাষায় লেখা

**উদ্দেশ্য:** Code slice-এর প্রতিটা function-এ pattern খুঁজে structured `Rule` বের করা, তারপর template দিয়ে লেখা।

```ts
interface Rule {
  id: string;            // kind + subject + normalized condition, স্থির থাকে
  kind: 'access' | 'field' | 'check' | 'reject' | 'query' | 'write' | 'effect' | 'ui-block' | 'ui-message';
  side: 'frontend' | 'backend';
  subject?: string;      // যেমন "departurePortId", "Route"
  condition?: Cond;      // AST থেকে বানানো ছোট condition tree
  outcome?: { status?: number; message?: string };
  source: { file: string; line: number };
}
```

**Extractor (`discovery/extractors/*`), এই app-এর জন্য গুরুত্বের ক্রমে:**

| # | Pattern | উদাহরণ output |
| --- | --- | --- |
| 1 | `auth(USER_ROLES.ADMIN)`, `optionalAuth` | "শুধু ADMIN এটা করতে পারে" / "Guest-ও পারে; login করা থাকলে user চেনা হয়" |
| 2 | Zod schema (backend v4, frontend v3): `.min/.max/.email/.uuid/.regex/.optional/.default/z.enum`। `{ body \| query \| params }` wrapper আর `validateBody/validateQuery` helper। `.superRefine/.refine`-এর message | "Port name কমপক্ষে ২ অক্ষর" / "Rule: Departure port and destination port cannot be the same" |
| 3 | `if (cond) throw new ApiError(StatusCodes.X, 'msg')`, `HttpExceptions` subclass, `findByIdOrThrow / ensureStatusOrThrow / ensureOwnershipOrThrow` | "Port না পাওয়া গেলে → 404: 'Port not found'" |
| 4 | Prisma: `findMany/count`-এর `where` (`contains + insensitive`, `deletedAt: null`, `isActive`, `gte`)। `create/update/delete/updateMany`। `updateMany`-এর `where`-এ guard + `count !== 1`। `$transaction`। `PrismaQueryBuilder().search([...]).sort(...)` | "নতুন Route save হয়" / "যথেষ্ট seat থাকলেই seat কাটা হয়" / "সব কাজ একসাথে হয়, একটা ব্যর্থ হলে কিছুই হয় না" |
| 5 | Side effect: `EmailService.sendEmail`, `stripe.*`, socket `emit`, `fileHandler(...)` | "Email পাঠায়" / "Stripe-এ refund করে" / "Logo upload, সর্বোচ্চ 2 MB" |
| 6 | Frontend: Button-এর `disabled={...}` আর তার label। `if (cond) { toast.error('msg'); return; }`। `onSuccess`-এর `toast.success`। `zodResolver(schema)` | "'Create Route' বন্ধ থাকে যখন দুই port একই, অথবা port ২টার কম" / "Frontend থামায়: 'Departure port and arrival port cannot be the same.'" |

**Condition কে মানুষের ভাষায় লেখা (`discovery/render/condition.ts`):**

- **যা বোঝা যাবে:** `!x`, `===` / `!==`, `<` / `>` / `<=` / `>=`, `&&` / `||`, `.length < n`, `includes`, member access (`formData.departurePortId` হয়ে যাবে "departure port")।
- **নাম ভাঙা:** camelCase নাম ভেঙে শব্দ বানানো হবে। Config-এ একটা `glossary` থাকবে নামের মানে লেখার জন্য: `{ "isArch": "archived" }`।
- **যা বোঝা যাবে না:** সেটা মিথ্যা অনুবাদ হবে না। Code-টুকু হুবহু দেখানো হবে, সাথে **"অনুবাদ হয়নি"** badge।

**Test এই rule check করে কিনা (deterministic):** rule-এর `message` যদি একই test-এর কোনো `should see "..."`-এর সাথে মেলে, অথবা `status` যদি কোনো `backend should reply N`-এর সাথে মেলে, তাহলে badge হবে **checked**। না মিললে **not checked**। এভাবে test-এ কোথায় ফাঁক আছে সেটা আপনা থেকে বেরিয়ে আসবে।

**Output আর UI:**

- `<outDir>/discovery/<test-slug>.json`-এ step অনুযায়ী rules থাকবে।
- UI-র test detail-এ নতুন "Business logic" panel। Rules step অনুযায়ী ভাগ করা থাকবে। প্রতিটা rule-এর সাথে থাকবে frontend/backend চিহ্ন, checked / not checked / অনুবাদ হয়নি badge, আর `file:line` link।
- CLI: `npm run ht -- discover <file.ht>` একই তথ্য terminal-এ দেখাবে।

**কাজ শেষ ধরা হবে যখন:** create-route flow-এর output-এ অন্তত এগুলো থাকে:

- শুধু ADMIN পারে
- দুই port-ই দিতে হবে
- same-port rule, frontend আর backend দুই জায়গা থেকেই
- port না থাকলে error
- route আগে থেকে থাকলে error
- নতুন Route save হয়

প্রতিটার সাথে সঠিক `file:line` থাকতে হবে।

**আকার:** মাঝারি, আর ধাপে ধাপে বাড়ানো যায়। প্রথমে 1–3 নম্বর extractor, কারণ এই flow-এর বেশিরভাগ rule ওখানেই। তারপর 4–6।

---

## Phase 4 — Fingerprint আর code বদলানো ধরা

**উদ্দেশ্য:** code বদলালে user-কে কিছু না বলেই জানানো, কোন flow-এর কোন rule বদলেছে।

1. **Baseline:** user একবার "Accept" করলে `.humantest/discovery/<test-key>.json` save হবে। এতে থাকবে code slice (function + hash) আর structured rules। এই file টা git-এ commit করার মতো।
2. **`npm run ht -- discover --changes`:** এর জন্য test চালাতে হবে না।
   1. শেষ trace থেকে code slice আবার বানাবে (phase 2), এবার বর্তমান code দিয়ে।
   2. Hash মিলিয়ে দেখবে কোন function বদলেছে।
   3. বদলানো function গুলোতে শুধু extractor আবার চালাবে।
   4. Rule `id` দিয়ে পার্থক্য বের করবে: **নতুন / বাদ গেছে / বদলেছে**। যেমন `min(2)` থেকে `min(3)`, বা নতুন একটা `throw`।
3. **যখন trace পুরোনো হয়ে যায়:** route table বা handler এমনভাবে বদলাতে পারে যে flow এখন অন্য endpoint-এ যায়। তখন শুধু hash দেখে সেটা বোঝা যাবে না। তাই route table-এরও hash রাখা হবে। সেটা বদলালে বার্তা আসবে: "এই flow আবার চালান, trace পুরোনো হয়ে গেছে"।
4. **কে বদলেছে:** `git log -1 -L <range>:<file>` দিয়ে কোন commit-এ, কে বদলেছে সেটা দেখানো হবে। এটাও deterministic, কোনো AI নেই।
5. **UI:** test list-এ badge থাকবে "logic বদলেছে"। Diff view থাকবে, আর একটা **Accept** button যেটা নতুন baseline বানায়।
6. **CI:** `discover --changes --check` কোনো accept না করা পরিবর্তন থাকলে exit code 1 দেবে।

**কাজ শেষ ধরা হবে যখন:** Island Hop-এ তিনটা পরীক্ষা ঠিক ফল দেয়:

- `route.validation.ts`-এ একটা `.min()` বদলালে, অথবা `route.service.ts`-এ নতুন `throw` যোগ করলে, শুধু সেই একটা rule diff আসে, আর কিছু না।
- Whitespace বা comment বদলালে কোনো diff আসে না।
- Flow-এর বাইরের কোনো file (যেমন `faq.service.ts`) বদলালে create-route flow-এ কোনো diff আসে না।

**আকার:** মাঝারি। Phase 2 আর 3 ঠিকভাবে বানানো থাকলে এর বেশিরভাগই তুলনা করার code।

---

## ক্রম আর ঝুঁকি

ক্রম: **0 → 1 → 2a/2b → 3 (extractor 1–3) → 4 → 2c → 3 (extractor 4–6)।** Backend আগে করার কারণ হলো বেশিরভাগ business rule backend-এই থাকে, আর সেখানে pattern গুলো খুব নিয়মিত। Frontend locator কম নির্ভরযোগ্য (label মিলিয়ে খোঁজা), তাই ওটা পরে।

| ঝুঁকি | কী করা হবে |
| --- | --- |
| Test ভুল করে remote/production backend-এ চলে যায় | Phase 0-এর localhost guard। Run-এর আগে API host check |
| Pattern-এর বাইরের code (dynamic route, computed key, raw SQL) | "unresolved / অনুবাদ হয়নি" হিসেবে দেখানো। কখনো চুপচাপ বাদ দেওয়া হবে না |
| নামের মান খারাপ (`isArch`) | Config `glossary` |
| অন্য project-এ অন্য stack (Nest, Mongoose, joi) | Extractor গুলো আলাদা plugin হিসেবে বানানো। নতুন stack মানে নতুন extractor, বাকি pipeline একই থাকবে |
| Legacy Mongoose model আর অব্যবহৃত notification framework | এগুলো trace-এ আসে না, তাই আপনা থেকেই বাদ পড়বে। Runtime-ভিত্তিক slicing-এর এটাই সুবিধা |
