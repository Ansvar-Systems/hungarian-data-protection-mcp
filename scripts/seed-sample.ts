/**
 * Seed the NAIH database with sample decisions and guidelines for testing.
 *
 * Includes real NAIH decisions (Budapest Bank, T-Systems Hungary, Magyar Telekom)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["NAIH_DB_PATH"] ?? "data/naih.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

interface TopicRow {
  id: string;
  name_local: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  { id: "consent", name_local: "Hozzájárulás", name_en: "Consent", description: "Az érintett hozzájárulásának gyűjtése, érvényessége és visszavonása (GDPR 7. cikk)." },
  { id: "cookies", name_local: "Sütik és nyomkövetők", name_en: "Cookies and trackers", description: "Sütik és nyomkövetők elhelyezése a felhasználók eszközein (ePrivacy irányelv)." },
  { id: "transfers", name_local: "Nemzetközi adattovábbítás", name_en: "International transfers", description: "Személyes adatok harmadik országokba való továbbítása (GDPR 44-49. cikk)." },
  { id: "dpia", name_local: "Adatvédelmi hatásvizsgálat (DPIA)", name_en: "Data Protection Impact Assessment (DPIA)", description: "Magas kockázatú adatkezelések hatásértékelése (GDPR 35. cikk)." },
  { id: "breach_notification", name_local: "Adatvédelmi incidens bejelentése", name_en: "Data breach notification", description: "Incidensek bejelentése a NAIH-nak és az érintetteknek (GDPR 33-34. cikk)." },
  { id: "privacy_by_design", name_local: "Beépített adatvédelem", name_en: "Privacy by design", description: "Adatvédelem beépítése a tervezésbe (GDPR 25. cikk)." },
  { id: "employee_monitoring", name_local: "Munkahelyi adatvédelem", name_en: "Employee monitoring", description: "Adatkezelés munkaviszonyban és munkavállalói megfigyelés." },
  { id: "health_data", name_local: "Egészségügyi adatok", name_en: "Health data", description: "Különleges kategóriájú egészségügyi adatok kezelése (GDPR 9. cikk)." },
  { id: "children", name_local: "Gyermekek adatai", name_en: "Children's data", description: "Kiskorúak adatainak védelme online szolgáltatásokban (GDPR 8. cikk)." },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
);
for (const t of topics) {
  insertTopic.run(t.id, t.name_local, t.name_en, t.description);
}
console.log(`Inserted ${topics.length} topics`);

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  {
    reference: "NAIH-2021-2858",
    title: "NAIH határozat — Budapest Bank Zrt.",
    date: "2021-09-15",
    type: "bírság",
    entity_name: "Budapest Bank Zrt.",
    fine_amount: 600_000_000,
    summary: "A NAIH 600 millió forintos bírságot szabott ki a Budapest Bank Zrt.-vel szemben súlyos adatvédelmi incidens miatt. Az incidens során körülbelül 130 000 ügyfél személyes és pénzügyi adatai jogosulatlan személyek számára váltak hozzáférhetővé szoftverhiba következtében.",
    full_text: "A Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH) a Budapest Bank Zrt.-vel szemben 600 000 000 Ft összegű bírságot szabott ki. A vizsgálat megállapította, hogy 2021 januárjában szoftverhiba következtében körülbelül 130 000 ügyfél személyes adatai — köztük névazonosító adatok, számlaszámok, egyenlegek és tranzakciós adatok — váltak hozzáférhetővé jogosulatlan személyek számára. A NAIH megállapított jogsértések: (1) Az adatkezelő nem hajtotta végre a GDPR 32. cikke alapján szükséges technikai intézkedéseket; (2) Az adatvédelmi incidenst 72 órán belül nem jelentette be a hatóságnak; (3) Az érintetteket késedelmesen és hiányosan tájékoztatta. A bírság meghatározásakor a NAIH figyelembe vette az incidens nagy léptékét és az adatok érzékeny jellegét.",
    topics: JSON.stringify(["breach_notification", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["32", "33", "34"]),
    status: "final",
  },
  {
    reference: "NAIH-2020-5765",
    title: "NAIH határozat — T-Systems Magyarország Zrt.",
    date: "2020-12-10",
    type: "bírság",
    entity_name: "T-Systems Magyarország Zrt.",
    fine_amount: 30_000_000,
    summary: "A NAIH 30 millió forint bírságot szabott ki a T-Systems Magyarország Zrt.-re amiatt, hogy a munkavállalók munkahelyi számítógép-használatát és e-mailjeit megfelelő jogalap és tájékoztatás nélkül figyelte meg.",
    full_text: "A Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH) 30 000 000 Ft bírságot szabott ki a T-Systems Magyarország Zrt.-vel szemben. A hatósági vizsgálat megállapította, hogy a társaság szoftver segítségével monitorozta a munkavállalók böngészési előzményeit és elektronikus levelezését. A jogsértések: (1) A munkavállalói megfigyeléshez nem állt rendelkezésre jogszerű jogalap — a munkavállalók hozzájárulása nem volt önkéntes; (2) A munkavállalókat nem tájékoztatták megfelelően az adatkezelés terjedelméről; (3) Nem készült adatvédelmi hatásvizsgálat. A NAIH elrendelte a jogsértő adatkezelési tevékenység megszüntetését.",
    topics: JSON.stringify(["employee_monitoring", "dpia", "consent"]),
    gdpr_articles: JSON.stringify(["5", "6", "13", "35"]),
    status: "final",
  },
  {
    reference: "NAIH-2022-1456",
    title: "NAIH határozat — Magyar Telekom Nyrt.",
    date: "2022-06-20",
    type: "bírság",
    entity_name: "Magyar Telekom Nyrt.",
    fine_amount: 100_000_000,
    summary: "A NAIH 100 millió forint bírságot szabott ki a Magyar Telekom Nyrt.-re amiatt, hogy weboldalaikon a sütikre vonatkozó hozzájárulás-mechanizmus nem felelt meg a GDPR előírásainak. A sütik visszautasítása nehezebb volt, mint elfogadásuk.",
    full_text: "A Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH) 100 000 000 Ft bírságot szabott ki a Magyar Telekom Nyrt.-vel szemben. A NAIH vizsgálata megállapította: (1) Az oldal nem kínált egyenértékű elutasítási lehetőséget az elfogadással szemben; (2) Egyes marketing sütik a hozzájárulás előtt kerültek elhelyezésre; (3) A cookie-tájékoztatás nem volt egyértelmű. A NAIH kötelezte a Magyar Telekomot, hogy három hónapon belül hozza összhangba gyakorlatát a GDPR követelményeivel.",
    topics: JSON.stringify(["cookies", "consent"]),
    gdpr_articles: JSON.stringify(["5", "7"]),
    status: "final",
  },
  {
    reference: "NAIH-2021-4123",
    title: "NAIH határozat — Állami egészségügyi intézmény",
    date: "2021-11-25",
    type: "bírság",
    entity_name: "Állami Egészségügyi Intézmény",
    fine_amount: 50_000_000,
    summary: "A NAIH 50 millió forint bírságot szabott ki egy állami egészségügyi intézményre, amiért páciensek egészségügyi adataihoz jogosulatlan személyek fértek hozzá és az intézmény nem rendelkezett megfelelő hozzáférés-kezelési szabályzattal.",
    full_text: "A NAIH 50 000 000 Ft bírságot szabott ki a vizsgált egészségügyi intézménnyel szemben. A hatósági eljárás megállapította, hogy egészségügyi munkavállalók azon betegek adataihoz is hozzáfértek, akiknek ellátásában nem vettek részt. A jogsértések: (1) A betegadatokhoz jogosulatlan személyek is hozzáférhettek, megsértve a GDPR 9. cikkét; (2) Az intézmény nem végzett adatvédelmi hatásvizsgálatot; (3) A technikai és szervezési intézkedések nem voltak megfelelők.",
    topics: JSON.stringify(["health_data", "dpia", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["9", "32", "35"]),
    status: "final",
  },
  {
    reference: "NAIH-2022-3891",
    title: "NAIH határozat — Online marketing vállalkozás (adattovábbítás)",
    date: "2022-10-05",
    type: "határozat",
    entity_name: "Online Marketing Kft.",
    fine_amount: 25_000_000,
    summary: "A NAIH megállapította, hogy egy online marketing vállalkozás ügyfelei személyes adatait USA-ban székhellyel rendelkező marketing platformokra továbbította a GDPR V. fejezete szerinti megfelelő garanciák nélkül.",
    full_text: "A NAIH 25 000 000 Ft bírságot szabott ki az Online Marketing Kft.-vel szemben. A NAIH vizsgálata megállapította, hogy a vállalkozás különböző online marketing platformokon helyezte el ügyfelei személyes adatait anélkül, hogy megfelelő garanciákat biztosított volna. Az Schrems II ítélet nyomán a Privacy Shield érvénytelenítése óta az USA-ba irányuló adattovábbítások csak az Általános Szerződési Feltételek és kiegészítő technikai intézkedések alkalmazásával felelnek meg a GDPR-nak. A NAIH kötelezte az adattovábbítási mechanizmusok felülvizsgálatára.",
    topics: JSON.stringify(["transfers", "cookies"]),
    gdpr_articles: JSON.stringify(["44", "46"]),
    status: "final",
  },
  {
    reference: "NAIH-2023-567",
    title: "NAIH határozat — Közösségi média platform (gyermekek)",
    date: "2023-03-14",
    type: "határozat",
    entity_name: "Közösségi Média Platform",
    fine_amount: 80_000_000,
    summary: "A NAIH 80 millió forint bírságot szabott ki egy közösségi média platformra amiatt, hogy 16 éven aluli kiskorúak számára életkor-ellenőrzés nélkül tette elérhetővé a platformot és adataikat reklámcélokra használta fel.",
    full_text: "A NAIH 80 000 000 Ft bírságot szabott ki egy közösségi média platformmal szemben. A vizsgálat megállapította, hogy a platform nem alkalmazott életkor-ellenőrzést, ennek következtében 16 éven aluli kiskorúak törvényes képviselőjük hozzájárulása nélkül regisztrálhattak, és adataikat reklámcélú profilalkotáshoz használták fel. A jogsértések: (1) A GDPR 8. cikke értelmében 16 évnél fiatalabb gyermekek adataihoz szülői hozzájárulás szükséges; (2) A profilalkotáson alapuló célzott reklámozáshoz nem volt megfelelő jogalap kiskorúak esetén; (3) Az adatvédelmi tájékoztató nem volt gyerekbarát nyelven megírva.",
    topics: JSON.stringify(["children", "consent", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["6", "8", "13"]),
    status: "final",
  },
  {
    reference: "NAIH-2023-1789",
    title: "NAIH határozat — Pénzügyi szolgáltató (késedelmes bejelentés)",
    date: "2023-07-30",
    type: "bírság",
    entity_name: "Pénzügyi Szolgáltató Zrt.",
    fine_amount: 40_000_000,
    summary: "A NAIH 40 millió forint bírságot szabott ki egy pénzügyi szolgáltatóra amiatt, hogy adatvédelmi incidensét késedelmesen — a 72 órás határidő után — jelentette be és az érintetteket sem értesítette.",
    full_text: "A NAIH 40 000 000 Ft bírságot szabott ki a Pénzügyi Szolgáltató Zrt.-vel szemben. Phishing támadás következtében 50 000 ügyfél adatai kompromittálódtak. Jogsértések: (1) Az incidenst csak 12 nappal felfedezése után jelentették be, holott a GDPR 33. cikke 72 órás határidőt ír elő; (2) Az érintetteket nem tájékoztatta az incidensről; (3) Az incidens bejelentése hiányos volt.",
    topics: JSON.stringify(["breach_notification"]),
    gdpr_articles: JSON.stringify(["33", "34"]),
    status: "final",
  },
  {
    reference: "NAIH-2022-6543",
    title: "NAIH határozat — Kereskedelmi vállalkozás (kamerarendszer)",
    date: "2022-08-18",
    type: "határozat",
    entity_name: "Kereskedelmi Vállalkozás Kft.",
    fine_amount: 15_000_000,
    summary: "A NAIH 15 millió forint bírságot szabott ki egy kereskedelmi vállalkozásra amiatt, hogy a munkahelyi kamerarendszer öltözőkben és pihenőhelyiségekben is működött, és a felvételeket aránytalanul hosszú ideig megőrizte.",
    full_text: "A NAIH 15 000 000 Ft bírságot szabott ki a kereskedelmi vállalkozással szemben. A hatósági vizsgálat feltárta, hogy kamerarendszert üzemeltetek öltözőkben és pihenőhelyiségekben, és a felvételeket több héten keresztül megőrizték. Jogsértések: (1) A kamerákat magánszférát különösen érintő helyiségekben helyezték el; (2) A munkavállalókat nem tájékoztatták a megfigyelésről; (3) Az adatmegőrzési időszak aránytalanul hosszú volt.",
    topics: JSON.stringify(["employee_monitoring", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["5", "13", "25"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(d.reference, d.title, d.date, d.type, d.entity_name, d.fine_amount, d.summary, d.full_text, d.topics, d.gdpr_articles, d.status);
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "NAIH-TAJEK-COOKIE-2022",
    title: "Tájékoztató a sütikre és nyomkövetőkre vonatkozó szabályokról",
    date: "2022-04-15",
    type: "tájékoztató",
    summary: "A NAIH tájékoztatója a sütik és nyomkövetők hozzájáruláshoz kötött alkalmazásáról. Ismerteti az érvényes hozzájárulás feltételeit, a sütibanner követelményeit és a visszautasítás egyenértékű biztosítását.",
    full_text: "A NAIH tájékoztatója a sütikre vonatkozó szabályokról. Főbb követelmények: (1) Hozzájárulás szükségessége — a nem technikailag szükséges sütikhez hozzájárulás kell elhelyezés előtt; (2) Érvényes hozzájárulás — szabad, konkrét, tájékozott és egyértelmű; (3) Egyenértékű visszautasítás — a visszautasítás ugyanolyan egyszerű legyen, mint az elfogadás; (4) Megújítás — legalább 12 havonta; (5) Dokumentálás — az adatkezelőnek igazolnia kell a hozzájárulást.",
    topics: JSON.stringify(["cookies", "consent"]),
    language: "hu",
  },
  {
    reference: "NAIH-UTMUTATO-DPIA-2021",
    title: "Útmutató az adatvédelmi hatásvizsgálat (DPIA) elvégzéséhez",
    date: "2021-09-01",
    type: "útmutató",
    summary: "A NAIH útmutatója az adatvédelmi hatásvizsgálat elvégzéséhez. Ismerteti mikor szükséges DPIA-t végezni, hogyan kell elvégezni és mit kell dokumentálni.",
    full_text: "A GDPR 35. cikke szerint DPIA-t kell elvégezni magas kockázatú adatkezeléseknél. DPIA szükséges különösen: nagy léptékű profilalkotásnál, különleges kategóriájú adatok nagy léptékű kezelésénél, szisztematikus megfigyelésnél. Lépések: (1) Az adatkezelés leírása; (2) Szükségesség és arányosság értékelése; (3) Kockázatelemzés; (4) Kockázatkezelési intézkedések; (5) Ha magas a maradványkockázat, NAIH konzultáció szükséges.",
    topics: JSON.stringify(["dpia", "privacy_by_design"]),
    language: "hu",
  },
  {
    reference: "NAIH-TAJEK-INCIDENS-2020",
    title: "Tájékoztató az adatvédelmi incidensek kezeléséről",
    date: "2020-06-01",
    type: "tájékoztató",
    summary: "A NAIH tájékoztatója az adatvédelmi incidensek kezeléséről és bejelentési kötelezettségéről. Ismerteti a bejelentési határidőket, a szükséges információkat és az érintetti értesítés feltételeit.",
    full_text: "Az adatvédelmi incidens a biztonság olyan megsértése, amely személyes adatok véletlen vagy jogellenes megsemmisítéséhez, elvesztéséhez, megváltoztatásához vagy jogosulatlan hozzáféréshez vezet. NAIH felé bejelentés (GDPR 33. cikk): 72 órán belül kell bejelenteni, ha kockázatot jelent. Az értesítésnek tartalmaznia kell: az incidens jellegét, az érintett személyek számát, a valószínű következményeket, a meghozott intézkedéseket. Érintetti értesítés (GDPR 34. cikk): Magas kockázat esetén az érintetteket is értesíteni kell — kivéve ha titkosítást alkalmaztak.",
    topics: JSON.stringify(["breach_notification"]),
    language: "hu",
  },
  {
    reference: "NAIH-IRANYMUTAS-MUNKAHELY-2022",
    title: "Iránymutatás a munkavállalók személyes adatainak kezeléséről",
    date: "2022-03-10",
    type: "iránymutatás",
    summary: "A NAIH iránymutatása a munkavállalók személyes adatainak kezeléséről a munkahelyeken. Kiterjed a kamerás megfigyelésre és az IT-rendszerek monitorozására.",
    full_text: "A munkahelyi adatvédelem a GDPR és a Munka Törvénykönyve alapján szabályozott. Munkavállalói hozzájárulás: Az egyenlőtlen hatalmi viszonyok miatt általában nem alkalmas jogalap. Kamerafigyelés: Tilos öltözőkben és szociális helyiségekben. A munkavállalókat tájékoztatni kell. IT-monitorozás: Arányos és célhoz kötött kell lennie. Előzetes tájékoztatás szükséges.",
    topics: JSON.stringify(["employee_monitoring", "consent", "privacy_by_design"]),
    language: "hu",
  },
  {
    reference: "NAIH-UTMUTATO-EGESZSEGUGYI-2021",
    title: "Útmutató az egészségügyi adatok kezeléséhez",
    date: "2021-01-20",
    type: "útmutató",
    summary: "A NAIH útmutatója az egészségügyi adatok GDPR-nak megfelelő kezeléséhez. Kiterjed az egészségügyi adatkezelés jogalapjaira és a biztonsági követelményekre.",
    full_text: "Az egészségügyi adatok különleges kategóriájú adatnak minősülnek (GDPR 9. cikk). Jogalapok: egészségügyi ellátás, közegészségügyi érdek, tudományos kutatás, kifejezett hozzájárulás. Hozzáférés-kezelés: szükségességi alapon — csak az ellátásban részt vevők férhetnek hozzá. Adatbiztonság: erős hitelesítés, titkosítás, hozzáférési naplózás. DPIA kötelező nagy léptékű egészségügyi adatkezelésnél.",
    topics: JSON.stringify(["health_data", "dpia", "privacy_by_design"]),
    language: "hu",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(g.reference, g.title, g.date, g.type, g.summary, g.full_text, g.topics, g.language);
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const guidelineCount = (db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }).cnt;
const topicCount = (db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }).cnt;
const decisionFtsCount = (db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }).cnt;
const guidelineFtsCount = (db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
