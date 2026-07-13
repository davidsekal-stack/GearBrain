# Handover

Aktualizováno: 2026-06-16

## Nepřekročitelné pravidlo pro seed importy

Parsery a crawlery jsou jen **coarse filter**. To platí zejména pro:
- `scripts/tsb-seed-nhtsa.mjs`
- všechny `scripts/forum-seed-*.mjs`

Závazné workflow:
1. parser/crawler může jen vytěžit kandidáty do `ready` a `to_review`
2. **každý kandidát určený k importu musí projít individuálním AI/manual review**
3. teprve potom smí jít do Supabase

Nepřípustné je:
- importovat NHTSA nebo forum `ready` dávku jen na základě parser verdictu
- spoléhat na pattern-level review tam, kde uživatel výslovně požaduje individuální kontrolu každého případu

Pro NHTSA konkrétně:
- `tsb-seed-nhtsa.mjs` je jen hrubý filtr a text normalizer
- `tsb-review-nhtsa-ai.mjs` musí finální accepted seed přepsat do krátkých symptom tagů; `symptoms` mají být krátké labely, typicky `1-4` slova, ne celé věty
- pokud je first-pass AI review pořád příliš široký, musí následovat druhý přísný per-case pass nad `ready + to_review`; na to je teď [scripts/tsb-second-pass-nhtsa-ai.mjs](/C:/GB/scripts/tsb-second-pass-nhtsa-ai.mjs)
- pokud seed obsahuje konkrétnější symptom, generic tagy typu `MIL on` nebo `Warning light` se mají odstranit, ne ponechat vedle něj
- pokud seed obsahuje explicitní `obd_codes`, nesmí zároveň nechávat redundantní symptom tag typu `DTCs P1234/...`; DTC patří do `obd_codes`, ne do `symptoms`
- pokud description explicitně uvádí konkrétní DTC a `obd_codes` jsou prázdné, mají se tyto kódy doplnit do `obd_codes` a následně z `symptoms` odstranit redundantní DTC tagy
- finální import se má dělat až po **individuálním průchodu všech kandidátů**
- pokud se po importu objeví nevalidní případ, má se:
  - smazat celé dotčené import okno ze Supabase
  - reviewed subset vytvořit znovu
  - nahrát jen ručně potvrzené případy
- `push-case` nesmí u reviewed NHTSA seedů znovu text přeformulovat; importer proto pro NHTSA posílá `skip_translation: true`
- `push-case` při duplicitě nesmí dělat jen no-op; musí přepsat celý case payload (`symptoms`, `obd_codes`, `description`, `resolution`, atd.), aby šel reviewed subset bezpečně reimportovat přes stejné `local_id`
- když se z full-supported běhu vyřezává brand subset, subset extraction a `tsb-review-nhtsa-ai.mjs` se nesmí pouštět paralelně; reviewer pak uvidí jen část ještě zkopírovaných souborů a vznikne falešně krátký AI review běh
- `tsb-review-nhtsa-ai.mjs` už umí resume z existujícího `ai_review_decisions.jsonl`; po síťovém failu proto navazuje od posledního zpracovaného kandidáta místo restartu celé značky

## Crawler: dedup případů z jednoho vlákna (2026-06-29)

**Problém:** jedno fórové vlákno = jedna diskuze, ale extraktor z něj uměl udělat víc případů (řádek „A thread may contain multiple independent resolved cases"). Když víc členů hlásilo TUTÉŽ závadu řešenou STEJNOU opravou (např. víc majitelů i30 montuje aftermarket klakson), vzniklo víc skoro-stejných karet. Sdílejí `source_ref` (`agent:thread:<url>`), takže korroborace v `search-cases` (dedup přes source_ref) je nezapočítá → čistý balast ve frontě i ve vyhledávání.

**Politika (majitel 2026-06-29):** stejná závada + STEJNÁ oprava = 1 karta (nechá se nejbohatší — nejvíc citovaných postů → delší řešení). RŮZNÉ opravy téhož příznaku zůstanou jako samostatné karty (vlákno „nenastartuje" s opravami filtr / čidlo vačky / řadicí táhlo = 3 karty). Cross-FORUM korroborace (různá vlákna) beze změny — viz dedup vs. korroborace níže.

**Prevence (v kódu):** [`scripts/agent/dedup-thread-cases.mjs`](/C:/GB/scripts/agent/dedup-thread-cases.mjs) — po extrakci LLM (route `dedupe` = `claude:haiku`) SHLUKNE duplikáty, KÓD nechá nejbohatší (model navrhuje, kód rozhoduje — jako verifier). Konzervativní (nejistota → nechat odděleně); chyby fail-open (nechá vše); quota propaguje. Zapojeno přes `pipeline.dedupeCases` v [`crawl.mjs`](/C:/GB/scripts/agent/crawl.mjs) + volání v `processThread` (volitelný krok — mock pipeline bez něj = staré chování). Doplněn pokyn i do extrakčního promptu. Test `tests/agent-dedup-thread-cases.test.js`.

**Úklid stávajících (vratný, proveden):** [`scripts/agent/dedup-existing-threads.mjs`](/C:/GB/scripts/agent/dedup-existing-threads.mjs) (dry-run default, `--apply`, `--revert <file>`). Mapuje agent.db case `id` == živý `local_id`. Duplikát → `gearbrain_cases.status='rejected'`, `review_reason='duplicate'` (CAS guard na `['approved','pending']`), uzavře otevřený řádek `crawl_review_queue` (`resolved_at`+`decision='rejected'`, jako lidský Zamítnout), agent.db → `crosscheck_dupe`. **`--apply`: 71 vláken posouzeno, 17 mělo duplikáty, 18 karet zamítnuto (15 nově, 3 už rejected), 0 chyb.** Záloha: `scripts/agent/.dedup-thread-backup-2026-06-29/`.

## DeepSeek v4 migrace (2026-06-16)

DeepSeek ukončuje `deepseek-chat` i `deepseek-reasoner` k **2026-07-24**. Přešli jsme na řadu v4:
- **Diagnostika** (`AI_MODEL` v [limits.js](/C:/GB/web/src/constants/limits.js)) → **`deepseek-v4-pro`** s uvažovacím režimem (`thinking: { type: 'enabled' }`). Nástupce `deepseek-reasoner`, vyšší kvalita, levnější než dnes.
- **Překlad/klasifikace na pozadí** ([push-case](/C:/GB/supabase/functions/push-case/index.ts), [search-cases](/C:/GB/supabase/functions/search-cases/index.ts)) → **`deepseek-v4-flash`** s `thinking: { type: 'disabled' }` (strukturovaný JSON, rychlost + spolehlivý parse).

`thinking` je top-level pole těla požadavku (ne `extra_body` — to je jen obal OpenAI SDK). [deepseek-proxy](/C:/GB/supabase/functions/deepseek-proxy/index.ts) ho propouští z payloadu (validuje `enabled`/`disabled`); staré modely zůstávají v allowlistu pro hladký přechod. Klient posílá `thinking` přes `buildAiRequestPayload` → `callAI`.

**Offline agent/seed pipeline (hotovo 2026-06-16):** celá offline/agentní pipeline, která dřív volala `deepseek-chat`, je teď na **`deepseek-v4-flash`** s `thinking: { type: "disabled" }` v těle requestu (strukturovaný JSON: klasifikace/extrakce/překlad/audit/verify). Migrované soubory:
- router crawl agenta [`scripts/agent/llm.mjs`](/C:/GB/scripts/agent/llm.mjs) — `verify` route + `deepseekChat()` default + nový (přepisovatelný) parametr `thinking`
- seed skripty `scripts/forum-seed*.mjs` — `DEFAULT_MODEL` v [base](/C:/GB/scripts/forum-seed.mjs), [club-root](/C:/GB/scripts/forum-seed-club-root.mjs), `vw/toyota/ford/fordtransit/peugeot/renault/audi/hyundai` (klubové značky `skoda/opel/bmw/seat/citroen/dacia/mercedes/tesla/nissan` dědí default z club-root)
- NHTSA pipeline [`scripts/nhtsa-supercrawler.mjs`](/C:/GB/scripts/nhtsa-supercrawler.mjs) + [`tsb-review-nhtsa-ai.mjs`](/C:/GB/scripts/tsb-review-nhtsa-ai.mjs) (sdílený `deepseekChatJson` používá i `tsb-second-pass-nhtsa-ai.mjs` a `forum-seed-fordtransit.mjs`)
- one-off retry skripty `retry-skoda-extractor.mjs`, `retry-skoda-classifier-review.mjs`
- audit [`audit/deepseek-judge.mjs`](/C:/GB/audit/deepseek-judge.mjs)

Pozn.: `thinking` je top-level pole raw HTTP requestu (ne `extra_body`). Endpoint zůstává `https://api.deepseek.com/v1/chat/completions`.

**Centralizace DeepSeek klienta (2026-06-16):** jméno modelu i celé HTTP volání teď žijí na jednom místě. Nový modul [`scripts/agent/deepseek.mjs`](/C:/GB/scripts/agent/deepseek.mjs) exportuje:
- `OFFLINE_DEEPSEEK_MODEL` — jediný zdroj pravdy pro offline model (dřív duplikováno jako `DEFAULT_MODEL` v ~16 souborech; budoucí výměna modelu = 1 edit). Importují ho všechny seed/NHTSA/retry skripty, `audit/deepseek-judge.mjs` i router `llm.mjs` (route `verify` + fallbacky).
- `deepseekChatJson(...)` — jeden odolný messages-based klient (retry, per-pokus timeout, detekce kvóty → `QuotaError`). Nahradil **11 ručně psaných kopií** (forum-seed `base/vw/toyota/ford/audi/hyundai/peugeot/renault/club-root` + 2× `retry-skoda`), které dřív neměly žádný retry ani timeout. `tsb-review-nhtsa-ai.mjs` teď exportuje tenký wrapper, který deleguje na sdílený klient se svými NHTSA parametry (temp 0.1, 90s timeout, 5 retry), takže `tsb-second-pass` i `forum-seed-fordtransit` jedou beze změny. Prompt-based `deepseekChat` (crawl agent) zůstává v `llm.mjs`, ale bere model/endpoint ze sdíleného modulu.

**deepseek-reasoner úklid (hotovo 2026-06-17):** poslední odkazy na vypínaný `deepseek-reasoner` na web cestě jsou přepnuté na `deepseek-v4-pro`: e2e harnessy [`scripts/e2e-followup-batch2.mjs`](/C:/GB/scripts/e2e-followup-batch2.mjs) + [`batch3.mjs`](/C:/GB/scripts/e2e-followup-batch3.mjs) a testovací fixtures [`tests/unit.test.js`](/C:/GB/tests/unit.test.js), [`tests/supabase-live/suites/edge-functions.js`](/C:/GB/tests/supabase-live/suites/edge-functions.js). V repu už `deepseek-reasoner`/`deepseek-chat` nikde nevolá žádný živý kód.

Vědomě ponecháno (není to volání modelu):
- historické výsledkové JSONy `scripts/e2e-followup-results*.json` — záznam minulých běhů, neměníme.
- allowlist `ALLOWED_MODELS` v [deepseek-proxy](/C:/GB/supabase/functions/deepseek-proxy/index.ts) pořád pouští `deepseek-chat`/`deepseek-reasoner` jako legacy; je to neškodné (nikdo je už neposílá) a vyčištění by si vyžádalo redeploy edge funkce — udělat při nejbližším deploy proxy.

## Co je teď důležité

Repo dnes pokrývá čtyři souběžné oblasti:
- webovou aplikaci v `web/` pro AI diagnostiku vozidel nad Supabase
- seed pipeline pro klubová fóra v `scripts/`
- import seedů do Supabase
- live testy interakce aplikace se Supabase v `tests/supabase-live`

Nejčerstvější praktický stav:
- seed metadata nesou `thread_url`, takže každý nový seed lze dohledat k původnímu vláknu
- existují hotové crawlery pro `VW`, `Toyota`, `Ford`, `Peugeot`, `Renault`, `Audi`, `Opel`, `BMW`, `SEAT`, `Citroën`
- pro `Citroën/BMW/Opel/SEAT` je nově připravený sekvenční batch runner nad root fóry
- Audi crawler byl po copy-paste chybě opraven a z druhého signals běhu bylo ručně potvrzeno `5 ready`
- z [TSBS_RECEIVED_2025-2025.txt](/C:/Users/sekald/Downloads/TSBS_RECEIVED_2025-2025/TSBS_RECEIVED_2025-2025.txt) je teď bezpečně importováno `at least 764` unikátních případů; poslední čistě uzavřený brand pass je `Volvo` `32/32`
- z [TSBS_RECEIVED_2025-2025.txt](/C:/Users/sekald/Downloads/TSBS_RECEIVED_2025-2025/TSBS_RECEIVED_2025-2025.txt) je teď bezpečně importováno `at least 1027` unikátních případů; nově je uzavřený i `Mercedes-Maybach` blok (`64/64`), plus malý safe alias blok `Maybach 2`, `Mercedes 6`, `Smart 6`
- na stejném souboru je nově uzavřený i poslední legacy mainstream unsupported block `Pontiac + Saturn + Saab`; po individuálním AI review skončil na `0 safe`, `Geo` zůstal mimo scope jako pre-2000 a `Isuzu` jako commercial-only
- Volvo pass už má doplněný US katalog pro `V90` a současné `MHEV/PHEV/BEV` aliasy; `V60CCPHEV` zůstal vědomě mimo katalog, protože pro US podporu nebyla dost silná oficiální opora
- další backlog na tom souboru už není legacy mainstream; zbývají hlavně unsupported niche/commercial makes jako `McLaren`, `BrightDrop`, `Workhorse`, `Karma`, `Ineos`, `Lotus`, `Rolls-Royce`, `Lamborghini`, `Koenigsegg`
- na [TSBS_RECEIVED_2020-2024.txt](/C:/Users/sekald/Downloads/TSBS_RECEIVED_2020-2024/TSBS_RECEIVED_2020-2024.txt) jsou zatím čistě uzavřené první 3 značky:
- na [TSBS_RECEIVED_2020-2024.txt](/C:/Users/sekald/Downloads/TSBS_RECEIVED_2020-2024/TSBS_RECEIVED_2020-2024.txt) jsou teď čistě uzavřené první 5 značek:
  - `Lincoln` `139`
  - `Genesis` `46`
  - `Infiniti` `30`
  - `Audi` `25`
  - `Polestar` `2`
- `Toyota` na stejném souboru prošla ready-only AI review + manuálním průchodem; z broad ready subsetu zůstal jen `1` safe případ, ale live import je teď zablokovaný chybějícím `IMPORTER_USER_ID` v edge `push-case`, takže stav DB se zatím nezměnil

## Stav větví a push do GitHubu

Aktuální workflow:
- změny se commitují a pushují průběžně přímo do `main`
- před dalším NHTSA během je dobré zkontrolovat čistý worktree přes `git status --short`
- pokud je potřeba přesná reference, ověř ji přímo přes `git rev-parse --short HEAD` a `git status --short`; tenhle handover se neudržuje po každém jednotlivém commitu s absolutně přesným SHA

## Aktuální stav pracovního stromu

Worktree má být při běžném postupu čistý nebo jen krátce rozpracovaný mezi testem a commitem. Zdrojové změny se teď dělají průběžně, testují a pushují přímo do `main`.

Artefakty, které si neplést se source of truth:
- [seed_*](/C:/GB) běhy a review adresáře
- [\.deploy-head-web*](/C:/GB/.deploy-head-web)
- [\.merge-main](/C:/GB/.merge-main)
- [\.tools](/C:/GB/.tools)

Pozor:
- `node.exe` i `npm.cmd` jsou na tomto stroji dostupné; po každé změně parseru/katalogu se reálně pouští cílené `node tests/...` a před commitem i širší ověření tam, kde dává smysl

## Hlavní vstupní body projektu

- web app shell: [web/src/App.jsx](/C:/GB/web/src/App.jsx)
- persistence pro web sessions: [web/src/lib/storage-sessions.js](/C:/GB/web/src/lib/storage-sessions.js)
- edge volání z webu: [web/src/lib/storage-edge.js](/C:/GB/web/src/lib/storage-edge.js)
- storage facade: [web/src/lib/storage.js](/C:/GB/web/src/lib/storage.js)
- Supabase klient/runtime config:
  - [web/src/lib/supabase.js](/C:/GB/web/src/lib/supabase.js)
  - [web/src/lib/runtime-config.js](/C:/GB/web/src/lib/runtime-config.js)
- edge functions:
  - [push-case](/C:/GB/supabase/functions/push-case/index.ts)
  - [search-cases](/C:/GB/supabase/functions/search-cases/index.ts)
  - [send-feedback](/C:/GB/supabase/functions/send-feedback/index.ts)
  - [deepseek-proxy](/C:/GB/supabase/functions/deepseek-proxy/index.ts)
- společný crawler základ:
  - [scripts/forum-seed.mjs](/C:/GB/scripts/forum-seed.mjs)
  - [scripts/forum-seed-club-root.mjs](/C:/GB/scripts/forum-seed-club-root.mjs)

## Co bylo uděláno naposledy

### 0. Crawl agent — fetch vrstva: got-scraping tier + robots.txt (2026-07-13, LOKÁLNĚ, nepushnuto)

**Kontext:** Test Apify residential proxy ukázal, že IP-blokace u dieselpower.cz /
forum.mazdaklub.eu proxy nevyřeší (403 na každé IP). Placený Apify se tedy zatím
nekupuje. Místo toho dvě vylepšení fetch kaskády ve
[`fetch-utils.mjs`](scripts/agent/fetch-utils.mjs), **bez nové závislosti** (obojí
už je v `crawlee`):

- **got-scraping tier** — fingerprintovaný HTTP request (TLS/JA3 + pořadí hlaviček)
  jako levný mezistupeň *před* prohlížečem v každé blokované větvi (403/406, 503,
  challenge). Sdílený helper `escalateBlockedFetch` (got-scraping → system-Chrome →
  Crawlee). Ověřeno: audizine.com 403 → 200 bez prohlížeče. **Opt-in**, výchozí
  vypnuto: `AGENT_ENABLE_GOTSCRAPING=1`.
- **robots.txt** — `AGENT_ROBOTS_MODE=off|log|enforce` (výchozí `off`). Lookup je
  ohraničený (5s timeout, 1 fetch/origin přes cache promisu, přes `AGENT_PROXY_URL`).
  **Známé omezení:** `enforce` vyhazuje fetch chybu, kterou orchestrátor/kalibrace
  zatím neodliší od reálného selhání (→ status `error`, může spustit pojistku fóra);
  produkčně používat `log`, dokud se nedoplní caller-side skip. Pro proxy platí:
  IP-blokace neřeší (ověřeno 13.7.).

Výchozí hodnoty = noční běh beze změny. Testy: `tests/agent-robots-gotscraping.test.js`,
celá `test:agent` sada zelená. Nepushnuto (čeká na souhlas majitele se zapnutím).

### 0. Crawl agent — věkový filtr vláken („netěžit mladší než rok") + defer/revisit (2026-06-25, LOKÁLNĚ, větev `feat/crawler-thread-age-defer`)

**Problém (nápad majitele):** crawler, který vlákno otevře, nenajde řešení a označí `discarded`,
už se k němu podle URL nikdy nevrátí — takže pozdě dodané řešení (tazatel se ozve za týdny/měsíce)
se navždy ztratí. Polovina věci už byla vyřešena dřív: **deep archive miner** (`enumerateThreadUrlsDeep`,
v `main` od commitu `8bfbe47`) prochází CELÝ archiv po stránkách s perzistentním kurzorem
(`forums.archive_cursor_json`), takže to nejde jen po „nejnovějším okně"; „exhausted" = `cursor.complete`
+ prázdná fronta → 30denní park → mělký head-scan na nová vlákna. Tahle relace doplnila druhou polovinu:
nesahat na vlákno, dokud nedozraje.

**Řešení (zvolen post-fetch defer, ne enumerace — datum NENÍ ve výpisu, jen v příspěvcích):**
- `parsers/common.mjs`: `parseWhenToDate` (ISO-8601 z `<time datetime>` + bare unix epoch; lokalizované/
  relativní → `null` = neznámé) + `threadLastActivity(posts)` (nejnovější parsovatelné datum).
- `crawl.mjs` `processThread`: mezi parse a classify spočítá poslední aktivitu; je-li mladší než
  `AGENT_MIN_THREAD_AGE_DAYS` (default 365), vrátí `{ deferred, lastPostAt, revisitAfter }` a NEvolá LLM.
  Neznámé datum → projde normálně (bezpečný směr; chrání ~17 generic .cz/.de fór bez `<time>` jako dosud).
  **Kalibrace se gate NEDOTÝKÁ** (volá `fetchAndParse`/`classify`/`extract` přímo, ne `processThread`) →
  fórum nikdy nepropadne kvůli mladým vzorkům.
- `orchestrator.mjs` `phaseCrawl`: na začátku per-forum `reviveDueDeferredThreads` (oživí dozrálá vlákna
  → `pending`); nová větev pro `result.deferred` → status `deferred` + `revisit_after` (NEukládá
  thread_text, ať se agent.db nenafoukne).
- `state.mjs`: sloupec `threads.revisit_after` (CREATE + ALTER), `deferred` v `THREAD_STATUS_PRIORITY`
  (15, mezi error a pending), `revisit_after` v `updateThread` allow-listu (jinak by se tiše zahodil!),
  `reviveDueDeferredThreads` (CAS `datetime(revisit_after) <= datetime('now')`), `countDeferredThreads`,
  `getThreadsByStatus`. `countCrawledThreads` vyřazuje `deferred` (není verdikt → nekazí yield).
- `daily-coach.mjs`: `deferred` se nepočítá jako „processed" (jinak falešný re-kalibrační signál
  „busy but barren").

**Rozhodnutí majitele:** věk dle DATA POSLEDNÍHO PŘÍSPĚVKU (ne založení); jakmile vlákno dozraje (>1 rok
ticho) a řešení tam pořád není, je „projité" a **natrvalo zahozené** (žádné opakované kontroly — proto
revisit běží jen u stále-mladých). Plus jednorázová záchrana starých zahozených (viz níže).

**Záchrana:** `recover-discarded.mjs` — jednorázově překlopí dříve zahozená „závada bez řešení" vlákna
`discarded`→`pending`, aby je noční běh přehodnotil novou age-aware pipeline. Dry-run report (po review-fixu
bucketingu): **2836 zachranitelných** z 4146 (1247 too_few vyloučeno, 63 terminal jen strukturální, 0 other);
default = re-judge, re-crawl+age-gate je skutečný filtr. Vratné a bezztrátové (`--revert <backup>` obnoví
i `discard_reason`; CAS na pending). **Pustit `--apply` AŽ po aktivaci** (jinak starý kód je zase zahodí).

**Stav:** testy `tests/agent-crawl-defer.test.js` (defer gate + revive + persistence + recovery selection),
celá `npm run test:agent` zelená (35 sad). **Aktivace = nechat checkoutnutou větev `feat/crawler-thread-age-defer`
pro noční běh** (crawler-only, žádný frontend → NEtřeba merge do main / Vercel deploy). Pak `recover-discarded.mjs --apply`.

### 0. Crawl agent — zpřísnění nezávislého verifikátoru (2026-06-17, LOKÁLNĚ)

Po ruční revizi 59 importovaných případů prošlo 9 chybných přes cross-vendor verifikátor.
Příčiny (5 tříd): vozidlo mimo záběr (motorka na DB aut/dodávek), vozidlo případu ≠ vozidlo
v citovaných příspěvcích (míchání více aut v jednom vláknu), „případ" co není porucha
(nastavení/menu, sourcing dílu, elektivní upgrade/retrofit/coding-aktivace, firmware
aftermarket krabičky, preventivní názor), „spravilo se samo", a nepotvrzená/vrácená závada.

[`scripts/agent/verify.mjs`](/C:/GB/scripts/agent/verify.mjs) přepsán z jednořádkového
`PASS`/`FAIL` na **strukturovaný JSON se 6 striktními booleany** (`in_scope`,
`vehicle_matches_cited_posts`, `is_genuine_fault`, `repair_performed`, `repair_confirmed`,
`actionable`); o `PASS`/`FAIL` rozhoduje **kód** (AND-brána, jakýkoli false/chybějící/
ne-boolean → FAIL). Do promptu se injektují `case_author` + `fault_post_numbers` +
`resolution_post_numbers` z payloadu (dřív nevyužité) → auditor soudí vozidlo/závadu/opravu
**jen z citovaných příspěvků** (oprava míchání aut). `is_genuine_fault` má inline allowlist,
aby NEodmítl skutečné opravy (čištění vč. ultrazvuku, aditivum, seřízení, přehrání **vlastní**
ECU vozu, oprava prokousané kabeláže, emulátor co **obnoví** selhanou tovární funkci, výměna
opotřebené originální součásti u veteránů). Deterministická pre-brána
`isLikelyOutOfScopeVehicle` (exportovaná) odřízne zjevné motorky/HGV bez DeepSeek volání —
klíčuje **jen na model** (ne na zdvih/rok), moto-regexy jen pro moto-značky, takže `320d`/
`Golf 1.8` nikdy nespadnou. Parse přes `indexOf('{')..lastIndexOf('}')`; nevalidní JSON →
1 retry → **fail-closed** do `verify_rejected` (nikdy tichý import). `temperature:0`.
Kontrakt `{verdict, reason}` beze změny, orchestrátor netknut.

Souběžně zpřísněna definice `has_explicit_fault` v
[`classify.mjs`](/C:/GB/scripts/agent/classify.mjs) (stejné ne-poruchové třídy se zahodí o
stupeň dřív; verifikátor je autoritativní brána, lidská review fronta je poslední pojistka).

**Validace:** živá regrese na 67 případech z předešlé noci — chyceno **8/8** chybných
(0/9 před změnou), **0** chybných odmítnutí na 50 potvrzených dobrých, identické verdikty
ve dvou bězích (deterministické). Logika pokryta
[`tests/agent-verify.test.js`](/C:/GB/tests/agent-verify.test.js) (parse, AND-brána, pre-brána,
retry/fail-closed). Účinné pro agenta od příštího plánovaného běhu (čte `verify.mjs` z disku).

**Pozn. k živým datům:** dvě už schválené (live) položky by nová brána chytila —
BMW E92 „CD měnič" (retrofit+coding, ne porucha) a Renault Clio 4 „servisní interval
se nezobrazuje" (hraniční, reset baterií). Majitel rozhodl obě nechat být (RAG je filtruje).

### 0b. Crawl agent — self-improving smyčka (daily coach), Fáze 1+2 (2026-06-19, LOKÁLNĚ)

Cíl: každé ráno vyhodnotit noční běh → diagnóza → (postupně) doladění crawleru. Architektura
navržena vícepohledovým workflow; klíčová **hranice autonomie** (rozhodl majitel):
**🟢 auto = technické/vratné** (priorita fór, cooldowny, re-kalibrace) · **🟠 shadow→schválení =
high-level** (prompty, prahy, trvalé vyřazení, strategie discovery).

**Vyhrazená ranní úloha (DŮLEŽITÉ):** kouč + recall-watchdog se NESPOUŠTÍ z 5min crawl dávky
(ta jede jen v okně 21:00–06:00 a běžela by na začátku okna proti prázdnému dni). Běží ze
samostatné úlohy **`DriveCodexDailyCoach`** (Task Scheduler, denně **06:20**, `StartWhenAvailable`)
přes [`run-coach-batch.ps1`](/C:/GB/scripts/agent/run-coach-batch.ps1); registrace
[`register-coach-task.ps1`](/C:/GB/scripts/agent/register-coach-task.ps1). Okno je **ukotvené na
začátek noci** (`nightCutoffUtc`, 21:00 lokálně), ne rolling 12 h.

- **Fáze 1 (HOTOVO, nasazeno):** [`daily-coach.mjs`](/C:/GB/scripts/agent/daily-coach.mjs) —
  OBSERVE+EMIT, jen měří, nemění knob. Strukturované metriky → tabulka `crawl_metrics`
  (state.mjs, long-format) + plain-CZ report `logs/daily-coach-*.md`; best-effort push do
  Supabase (`crawl_metrics` + `crawl_daily_report`, migrace 023). Report se zobrazuje v
  **admin Analytics panelu** (edge fn `analytics` vrací `daily_report`, render v `AnalyticsPanel.jsx`).
  Funnel/ratia z JEDNÉ kohorty (created-in-window); degenerovaná noc nerazítkuje denní slot.
- **Fáze 2 (HOTOVO, lokálně 2026-06-19):** auto-tier adapt logika v kouči. Čistý planner
  [`coach-adapt.mjs`](/C:/GB/scripts/agent/coach-adapt.mjs) (bez DB/času → deterministický,
  unit-testovaný) rozhodne max **1 vratnou změnu na fórum a den**:
  - **priorita** z ověřeného výnosu `y=(G+1)/(P+10)`, cíl `round(y·100,1)`; dvouokenní monotonie
    (3 noci i 2 noci stejný směr) + deadband 5 + krok ±15 + no-churn 0.5; jen `status∈{active,exhausted,queued}`,
    3 husté noci ≤21 dní staré, Σprocessed≥20, Σ(good+rej)≥5. `G`=NARROWED (jen verified/import_ready/imported).
  - **cooldown** zkrátit 168→24 h / prodloužit 24→168 h, jen v mezích enginu (nikdy 720 h ani null);
    tier čte z NOVÝCH engine sloupců `forums.cooldown_tier_hours`+`cooldown_set_at` (stamp jen u yield-parku,
    clear u error parků → invariant: nenull ⇔ čistý yield-park); zámek na `exhausted`/0-new; transient guard
    (≥30 % transientních z processed+transient → skip); **10denní anti-flap** přes coach_journal.
  - per-forum noční metriky v `aggregateNight` (`forum_processed`[non-pending,non-transient],
    `forum_extracted`, `forum_transient`[error/transient/pending-transient], `forum_too_few`) → `crawl_metrics`
    (scope=forum) pro hysterezi; husté i pro „busy-but-barren" fóra (explicitní nuly).
  - **Guardrails:** min-volume, hystereze 2–3 noci, **50% circuit-breaker** (víc než půlka fór najednou → 0 změn),
    globální cap 8/noc (nejsilnější první), degenerovaná noc → 0 adaptu. Vše do `agent_log` phase='coach'.
  - **Undo:** atomický `applyCoachChange` (BEGIN IMMEDIATE: update+insert, rollback na partial UNIQUE(date,forum_id)
    WHERE applied=1 = zámek 1/fórum/den) zapíše `coach_journal` (old→new přesně měněných sloupců). Vrácení:
    [`apply-proposal.mjs --revert`](/C:/GB/scripts/agent/apply-proposal.mjs) = **compare-and-swap** (obnoví jen
    když fórum stále drží zapsanou hodnotu, jinak nepřepíše novější), `--list`/`--date`/`--forum`/`--knob`/`--dry-run`, idempotentní.
  - Report sekce **„Co jsem automaticky upravil"** (plain CZ, vratné, nikdy nesahá na prahy/prompty).
  - **DŮLEŽITÉ — re-kalibrace zůstala SHADOW (návrh, ne auto):** původně plánovaná jako auto, ale adversariální
    review ji zamítl z auto-tieru — jako JEDINÝ knob není vratná column-rollbackem (re-discovery přepíše config
    dřív, než by netechnický majitel stihl `--revert`) a triggery nerozliší rozbitý parser od soft-blocku /
    vyčerpání obsahu / plošné změny verifikátoru. Kouč proto STUCK fórum (3 noci Σprocessed≥30, 0 vytěženo,
    transient≤20 %, „málo příspěvků" nedominuje) jen **navrhne** (`coach_journal` applied=0 + report sekce
    „Možná potřebují ruční kontrolu struktury"); člověk spustí ručně `reset-forum.mjs`. Plně auto re-kalibrace = Fáze 4.
  - **Cold-start:** nové per-forum metriky → ~2–3 noci než cokoli sepne (čekané ticho, ne bug). `forum_good`
    v reportu je nově NARROWED → čísla „dobré po fórech" klesnou (např. Audi 34→16) = záměr (jen skutečně nové dobré případy).
  - Testy: **28 agentních zelených** (+`agent-coach-adapt`, `agent-coach-journal`).
- **Recall watchdog:** stejná vyhrazená úloha; QUALITY_BAR dokalibrován o „stejný autor" +
  „shoda vozidla" (dřív falešně 8/12 → teď 0/3). Alert → desktop marker
  `DRIVECODEX-VERIFIKATOR-PRISNY-PRECTI-ME.txt` (mirror v `run-coach-batch.ps1`).
- **Fáze 3 (HOTOVO, lokálně 2026-06-19) — precision auditor:** zrcadlo recall-watchdogu v OPAČNÉM
  směru. [`precision-auditor.mjs`](/C:/GB/scripts/agent/precision-auditor.mjs) vzorkuje ~12 SCHVÁLENÝCH
  případů (3 řezy: 4 nejnovější importy + 5 rizikových dle `riskScore` z payloadu + 3 náhodné; pokrytí
  v `agent_meta precision_audited_ids`, ring-buffer 500), nezávisle je přehodnotí Claudem
  (`AGENT_LLM_COACH-PRECISION`, default claude:haiku) proti SDÍLENÉ `QUALITY_BAR` (vyfaktorováno do
  [`quality-bar.mjs`](/C:/GB/scripts/agent/quality-bar.mjs), recall-watchdog ji re-exportuje — jeho
  prompt zůstal byte-identický). Hlásí míru „chybně PŘIJATÝCH". Čtyři vědomé inverze proti recall zrcadlu:
  (1) **fail-OPEN** — nečitelný verdikt je pokrytá mezera, ne tiché „přijetí OK" (jeden levný re-ask, pak
  `precision_unparsed`); (2) soudí **CLAMPNUTÝ uložený artefakt** pro `imported` (co fakt vlezlo do DB);
  (3) desktop marker `DRIVECODEX-PRECIZNI-AUDITOR-PRECTI-ME.txt` jen na **7denní pooled** míře (≥3 a ≥15 %)
  NEBO **clusteru na jedné podmínce** (a-e) — ne jednodenní binárka, žádný marker na 1 vysokou jistotu
  (anti-alarm-fatigue); (4) **skeptický prompt** musí pojmenovat porušenou podmínku. REPORT-ONLY (žádná
  brána/knob). Signál pro Fázi 4: `crawl_metrics precision_*` + `logs/precision-labels.jsonl` (strojový
  label-seed, ne lidský gold). 3. krok ranní úlohy `run-coach-batch.ps1`. Testy: **29 agentních zelených**
  (+`agent-precision-auditor`).

**Validace:** review (5 dimenzí + adversariální ověření) — bezpečnost/RLS/XSS/observe-only OK;
opraven časovací cluster (viz výše). 26 agentních testů zelených.

**▶ STAV:** Fáze 1 nasazená; Fáze 2 (priorita + cooldown auto, re-kalibrace shadow) + Fáze 3
(precision auditor, report-only) hotové. **2026-06-24 (LOKÁLNĚ, nepushnuto) přidány dvě AKČNÍ smyčky:**
- **AUTO překalibrace** [`recalibrate-guarded.mjs`](/C:/GB/scripts/agent/recalibrate-guarded.mjs) (krok 5
  `run-coach-batch.ps1`): povýšila shadow návrh z Fáze 2 na bezpečnou akci. Běží přes **bufferující obal
  stavu** (`makeBufferingState`) — skutečný řádek fóra se NESÁHNE, dokud nový pokus neprokáže lepší výnos
  (vs. honest baseline probe; práh + marže `RECAL_MIN_YIELD_GAIN` + neprázdné sekce), jinak rollback +
  attempt-marker (anti-flap 7 dní). 1 fórum/noc, profilová fóra přeskočena, quota → exit 3 (zkrat dávky).
  Vratné: `apply-proposal.mjs --revert --knob recalibrate`.
- **OPATRNÝ agent nad alarmem** [`alert-agent.mjs`](/C:/GB/scripts/agent/alert-agent.mjs) (krok 4, jen když
  `precision-alert.txt`): reversibilně dá do **karantény** případy s vysokou jistotou (živý `gearbrain_cases`
  pending/approved→`rejected` atomickým CAS přes `local_id`, pak lokální `quarantined` + deník `quarantine`;
  live-first s kompenzací při selhání lokálního zápisu). Diagnóza + doporučení zpřísnění brány jen REPORT-ONLY
  (na bránu/prompt NESAHÁ). Vratné: `apply-proposal.mjs --revert --knob quarantine` (obnoví i živý stav).
- Schéma: `coach_journal` má `target_kind`/`case_id`; revert dispatchuje forum vs. case; nový stav případu
  `quarantined` je inertní (žádný selektor ho nepřebírá). **31 agentních testů zelených** (+`agent-recalibrate-guarded`,
  `agent-alert-agent`); web lint+build OK; produkční round-trip karantény ověřen a vrácen.

Pozn.: skripty běží z pracovní kopie → ranní dávka už používá nový kód. 🟠 shadow kanál pro prompty/prahy se
NESTAVĚL — vázaný na gold-set. DALŠÍ NA ŘADĚ = Fáze 4 (gold-set session s majitelem) — zbývá z ní už jen
propose-and-gate pro PROMPTY/PRAHY; (e) auto re-kalibrace HOTOVÁ.

**▶ POZDĚJŠÍ FÁZE (roadmapa, každá samostatně nasaditelná):**
- **Fáze 3 — precision auditor (zrcadlo recall-watchdogu): ✅ HOTOVO (viz výše).** Měří míru „chybně
  PŘIJATÝCH" (report-only) — předpoklad, než smí být cokoli povoleno (loosening). Akumuluje
  `logs/precision-labels.jsonl` (strojový label-seed) + `crawl_metrics precision_*`, které Fáze 4 čte jako trend.
- **Fáze 4 — propose-and-gate pro rizikové knoby (prompty/prahy):** (a) jednorázově s majitelem
  nakurátorovat **zmrazený gold-set** `scripts/agent/gold/gold-cases.jsonl` (~40–80 jasně dobrých/
  špatných vláken, ~1–2 h — Fáze 4 je bez něj nebezpečná a blokovaná); (b) gold-eval harness nad
  exportovanými branami (`verifyCase`/`isClassifierApproved`/`validateCase`); (c) řazená fronta
  návrhů (`logs/proposals/*.json` + agent_meta `coach_proposals_open`) → desktop marker
  `DRIVECODEX-DENNI-DOPORUCENI-PRECTI-ME.txt`; (d) **`apply-proposal.mjs`** = JEDINÝ mutátor
  rizikových změn (Tier A/B s mezemi + undo token; Tier C prompt/práh jen NAstaguje draft →
  manuální review + `npm run test:agent` + gold harness + výslovné OK majitele → teprve commit;
  invariant: verify vendor ≠ extract vendor). Riziko vstupuje až tady, vždy za lidskou bránou.
  - **(e) AUTO re-kalibrace: ✅ HOTOVO 2026-06-24** ([`recalibrate-guarded.mjs`](/C:/GB/scripts/agent/recalibrate-guarded.mjs)).
    Původní obavy z nevratnosti vyřešeny jinak (a lépe) než navrhováno: místo „engine odložení re-discovery ≥1 cyklus"
    se kalibrace pouští přes **bufferující obal** (skutečný řádek se nesáhne, dokud kandidát neuspěje → `--revert` jde
    KDYKOLI, ne jen týž den); cooldown 7 dní (env `RECAL_COOLDOWN_DAYS`); `calibration_attempts<3` drží interně sama
    `calibrateForum` (MAX_ATTEMPTS=3) + buffering brání bumpu attempts při neúspěchu. **Zbývající rozdíl od plánu:**
    confounder gate z recall-watchdogu (na noc s driftem verifikátoru nedělat strukturální akci) NENÍ explicitní — místo
    toho je akce vázaná na čerstvý baseline+candidate **probe** (extractor yield z vlastní kalibrace, ne z verifikátoru),
    takže drift verifikátoru ji přímo neovlivní; explicitní confounder gate je možné budoucí zpřísnění.

**Průřezové guardrails (platí pro všechny fáze):** cíl je **PRECISION, ne YIELD** — žádná akce,
jejíž efekt je „projde víc případů branou", se nikdy neaplikuje automaticky (jen navrhne); vše
vratné + auditovatelné; min-volume + degenerate-night skip; kouč nemá git/push/deploy ani zápis
do zdrojů bran. Otevřená rozhodnutí majitele: kdy gold-set session; kadence alertů; quota budget
(precision auditor ~+12 Claude volání/den); retence `daily_metrics`. Detailní návrh: workflow
„design-self-improving-crawler" (synthesis) — výstup v session tasks.

### 0. Hybrid follow-up — konverzace „s mechanikem" po diagnóze (2026-06-16, LOKÁLNĚ, ČEKÁ NA NASAZENÍ)

Doplňující dotaz po první diagnóze už neběží jako re-run bez kontextu. `executeDiagnosis`
([web/src/lib/run-diagnosis.js](/C:/GB/web/src/lib/run-diagnosis.js)) pozná follow-up tak,
že v případu už existuje diagnóza (`getLatestDiagnosis`), a místo `buildSystemPrompt` použije
`buildFollowupSystemPrompt` — ta do promptu přidá **shrnutí předchozí diagnózy**
(`buildPriorDiagnosisContext`: shrnutí + závady s procenty) a pravidla režimu. AI v JEDNOM
volání rozhodne:
- **režim „odpověď"** (mechanik se ptá) → vrátí `{"režim":"odpověď","odpověď":"…"}`, z čehož
  vznikne nová zpráva typu `MSG.REPLY` (`reply`) renderovaná jako textová bublina
  (SessionTimeline, SharedCaseView, PDF `renderReply`). `isReplyResult` v
  [diagnosis.js](/C:/GB/web/src/lib/diagnosis.js) detekuje režim (explicitní `režim` nebo text bez `závady`).
- **režim „diagnóza"** (mechanik hlásí nové zjištění/test/opravu/kód) → vrátí aktualizovaný JSON
  závad jako dosud; navazuje na minulou diagnózu (vyřadí vyloučené příčiny, zvýší potvrzené).

`smartRepair` ([ai-json-repair.js](/C:/GB/web/src/lib/ai-json-repair.js)) nově zvládá i JSON
obalený code-fencem (fallback parse do poslední `}`) — pomáhá konverzačním odpovědím.
Žádná změna RAG vah ani bran. Žádná migrace. AI zůstává **DeepSeek** (`deepseek-reasoner`).

**Ověřeno E2E na živém DeepSeek API** ([scripts/e2e-followup-test.mjs](/C:/GB/scripts/e2e-followup-test.mjs),
volá reálnou edge fn `deepseek-proxy`): 10 scénářů (otázky proč/jak/co, vyloučení příčiny měřením
komprese, potvrzení leak-off testem, neúspěšná oprava, nový příznak, nový OBD kód, rada na svépomoc,
off-topic dotaz). **10/10 režim i obsah dle předem zapsané predikce**; výsledky v
`scripts/e2e-followup-results.json`. Jediné pozorování: `deepseek-reasoner` je upovídaný a u režimu
„diagnóza" může výjimečně narazit na `AI_MAX_TOKENS` (4000) — `smartRepair` ořez ustojí (zobrazí
kompletní závady, uťatou zahodí). Případné zvednutí limitu pro follow-up je volitelné doladění.

Rozšířeno o **dávku 2 (20 případů)** a **dávku 3 (8 záludných hran)** — viz
`scripts/e2e-followup-batch2.mjs` / `e2e-followup-batch3.mjs`. Celkem **38/38 správný režim**,
obsah 0 chybných (po doladění promptu); pokrytí přes benzín/turbo/DPF/AdBlue/DSG/ABS/chlazení/
nabíjení/EV/hybrid/rozvody/podvozek + EN/DE. Záludné hrany (dotaz+zjištění v jedné zprávě, vágní
„co teď", změna tématu, emoce, nesouhlas, zjištění jako otázka, poděkování) prošly 8/8.

**Přednasazovací review (adversariální, 5 dimenzí → ověření → syntéza): GO, 0 blokerů.** Opravené
nálezy: (1) **major** — doplňující DOTAZ se ukládal jako `MSG.INPUT` a vlézal do pozdějších diagnóz
i do RAG korpusu (`description` v `buildPushClosedCasePayload`); fix = příznak `fromReply:true` na
inputMsg reply-větve, vyloučen v `collectCaseInputs` i `buildPushClosedCasePayload`; (2) `smartRepair`
fallback přepsán z `lastIndexOf("}")` na **balanced-scan** prvního top-level objektu (trailing próza
s `}` už nerozbije parse); (3) `isReplyResult` u explicitního `režim:"odpověď"` vyžaduje neprázdný
text (jinak propadne na diagnózu); (4) anti-override věta ve `FOLLOWUP_RULES` + délkový strop
`REPLY_MAX_LENGTH` (2000) na odpověď (prompt-injection hardening — text mechanika se zobrazuje pod
značkou „DriveCodex"); (5) +8 unit testů (orchestrace `executeDiagnosis` reply/diagnóza větve,
fromReply vyloučení, balanced-scan). **Vědomě odloženo (ne-blokery):** věrná paměť vícekolových
textových odpovědí (dnes se do promptu předává jen poslední strukturovaná diagnóza — záměr) a
sdílení render bloku REPLY mezi `SessionTimeline`/`SharedCaseView` (kopíruje zavedený vzor).

### 0a. RAG: lepší výběr a řazení podobných případů (2026-06-15)

`search-cases` filtruje kandidáty dvěma branami — (1) absolutní skóre ≥ dynamický
práh `min(8; 0.7·inputMax)` a (2) F1 oboustranná shoda ≥ `MATCH_RATIO_MIN` (0.5) —
a nově **řadí podle F1 shody** (`matchRatio` ↓, absolutní skóre jen tiebreak), ne podle
absolutního skóre. F1 = 2·fwd·rev/(fwd+rev), kde fwd = skóre/inputMax, rev = skóre/candidateMax.
Důvod: F1 je v rozsahu ⟨0,1⟩ nezávisle na tom, jak bohatý dotaz uživatel zadal, takže
„vysoká shoda" znamená totéž u stručného i podrobného dotazu a pořadí je stabilní, jak DB
roste. Toto pořadí zároveň určuje, kterých max 5 unikátních případů projde do promptu.

Frontend `buildRagBlock` ([web/src/lib/ai-prompts.js](/C:/GB/web/src/lib/ai-prompts.js)) štítkuje
🔴/🟡/🟢 podle `ragMatchRatio` (≥0.72 / ≥0.58 / zbytek), s fallbackem na původní absolutní práh
skóre (8/5), když pole chybí. Edge fn `ragMatchRatio` vrací už dnes — při nasazení nasadit edge
fn a web blízko po sobě (edge napřed), ať se štítek a pořadí nerozejdou. Bez změny vah, bez změny bran.

**Výběr kandidátů (recall).** Dřív se skórovalo jen 200 NEJNOVĚJŠÍCH případů značky → u velkých
značek mohla nejlepší shoda být starší a tiše vypadnout. Nově `search-cases` sjednocuje až tři
paralelní indexované dotazy podle SÍLY SIGNÁLU, ne stáří: (A) překryv OBD kódů (limit 150, GIN
index), (B) rodina modelu přes `ilike('vehicle_model','<prefix>%')` (limit 100, napříč generacemi),
(C) nejnovější případy značky (limit 200, záchytná síť pro dotazy bez signálu). U A i B je řazení
dle data jen deterministický tiebreak při překročení limitu — filtr (OBD/model) drží relevanci.
Sjednoceno a deduplikováno podle `id` (čistá funkce `buildCandidateRows`), pak beze změny vstupuje
do scoringu. Max ~450 řádků, vše server-side (edge↔DB v rámci Supabase); k uživateli jde stále jen
top-5. Bez nové migrace/indexu.

**Korroborace (Krok 3 — implementováno 2026-06-16, ČEKÁ NA NASAZENÍ).** `search-cases` nově počítá,
kolik NEZÁVISLÝCH prošlých případů potvrzuje stejnou KLASIFIKOVANOU závadu (`canonical_fault_id`),
dedup přes `source_ref` (fan-out nenafoukne), nad prošlými kandidáty (bez extra dotazu). Toto číslo:
(a) dává OMEZENÝ bonus k řazení — `matchRatio × corroborationBoost(count)`, kde boost = `1 + (min(count,8)−1)/7 × 0.12`
(max +12 %), takže near-perfect shoda s 1 případem (0.95) pořád poráží slabší s 8 (0.80×1.12=0.896) —
match-kvalita zůstává hlavní; konstanty `CORROBORATION_CAP`/`CORROBORATION_MAX_BOOST` = snadné doladění síly;
(b) sloučí stejnou klasifikovanou závadu do jednoho zástupce (top-5 ukazuje různé možnosti, ne kopie);
(c) vrací se jako `ragCorroboration`, `buildRagBlock` ho ukáže jako „potvrzeno v N případech" (cs/en/de),
což zpřesní pole `početShod` v diagnóze. **~50 % případů je zatím neklasifikovaných** (`canonical_fault_id`
NULL) → count 1, žádný bonus, neslučují se = NULOVÁ regrese; síla roste, jak agent doklasifikovává.

Vědomě ODLOŽENO (samostatný follow-up, NE Krok 3): okrajový případ >150 případů se stejným OBD kódem
u jedné značky (potřebuje řazení uvnitř DB; rizikovější, špatně lokálně testovatelné).

### 0b. Panel „Známé závady tohoto vozu" (web) — statistiky závad z RAG (2026-06-15)

Nová funkce (větev `feat/known-faults-panel`): na obrazovce nového případu se po
výběru vozidla zobrazí žebříček nejčastějších potvrzených závad pro danou
**rodinu modelu + generaci** z `gearbrain_cases`. Bez AI tokenů (čisté DB čtení),
fail-quiet (při chybě se nevykreslí nic).

Datové vrstvy (migrace `021_known_faults.sql`):
- `gearbrain_fault_taxonomy` — číselník kanonických závad (slug + label_cs/en/de + category).
- `gearbrain_cases.canonical_fault_id` (NULL = nezařazeno, `'other'` = nezařaditelné)
  a `vehicle_generation` (generace doplněná backfillem, když nejde z `vehicle_model`).
- Generované STORED sloupce `model_base`/`model_gen`/`model_year` přes IMMUTABLE funkce
  `normalize_model_family`/`extract_model_gen`/`extract_model_year`. **POZOR: změna
  těchto funkcí NEpřepočítá stored sloupce — nutné je dropnout a přidat znovu.**
- RPC `known_faults_for_vehicle` (agregace × pásmo × gen_match) a `known_fault_cases`
  (detail, dedup podle source_ref).

Backend/skripty: edge fn `known-faults` (mode stats/cases, TTL cache, fail-quiet),
`push-case` rozšířen o klasifikaci nového případu do číselníku ve stejném DeepSeek
volání jako překlad (fail-open na NULL), standalone `scripts/agent/fault-taxonomy.mjs`
(`--seed` číselník přes LLM, `--classify` dávkové roztřídění + generační inference,
`--stats`). JS normalizace modelu (`splitModel`) je zrcadlo SQL funkcí — musí zůstat
v souladu (kryto testy `tests/agent-fault-taxonomy.test.js`).

Frontend: `web/src/components/KnownFaultsPanel.jsx`, `web/src/lib/known-faults.js`,
wrappery ve `storage-edge.js`, zapojení v `NewCaseView`, předvyplnění hypotézy do
`InputForm` (OBD kódy projdou stejnou validací jako ruční zadání), i18n `known.*` (CS/EN/DE).

Nasazení (2026-06-15, produkce):
- **Migrace 021 byla provedena RUČNĚ přes Supabase dashboard SQL editor**, ne přes
  `supabase db push` — z dev sítě jsou blokované DB porty (5432/6543), projde jen HTTPS.
  Migrace tedy NENÍ v `supabase_migrations.schema_migrations`. Je idempotentní
  (IF NOT EXISTS / CREATE OR REPLACE), takže příští `db push` z funkční sítě ji bezpečně
  „přejede" nebo přeskočí; případně doplnit záznam do historie ručně.
- Edge funkce `known-faults` + `push-case` nasazeny přes `functions deploy` (jede přes HTTPS,
  Docker netřeba).
- Číselník naseedován (118 závad), case backfill: **99,8 % zařazeno, generace u 97,9 %**.
- Průběžné zatřídění: noční runner `scripts/agent/run-agent-batch.ps1` (Krok 2) spouští
  `fault-taxonomy.mjs --classify --max 1000` jako NON-FATAL krok — dobere approved
  případy bez `canonical_fault_id` (push-case klasifikuje jen na měkko a skip_translation
  importy ji přeskakují). Drží panel aktuální bez ruční práce; resumovatelné.

### 0c. Lokalizace textů oprav v panelu „Známé závady" (migrace `022_resolution_i18n.sql`)

Problém: text potvrzené opravy (`gearbrain_cases.resolution`) je v DB **vždy anglicky**
— `push-case` i crawl agent překládají vstup do angličtiny kvůli jazykově nezávislému
RAG. Rozhraní se přepne, ale text opravy zůstal anglicky.

Řešení: vedle kanonického anglického `resolution` (zůstává beze změny — **RAG na něm
závisí, nikdy ho neměnit**) se ukládají lokalizované varianty:
- `resolution_cs` / `resolution_de` — česká/německá verze (NULL = nepřeloženo → panel
  zobrazí anglický originál).
- `resolution_lang` — detekovaný jazyk **originálu vstupu**; do shodného jazyka se
  nepřekládá (uloží se původní text, autenticky) a slouží i jako značka „zpracováno"
  pro resumovatelný backfill.

Výběr jazyka je **na klientu** (`web/src/lib/known-faults.js → localizeResolution`,
stejný vzor jako `pickFaultLabel`), edge fn `known-faults` proto vrací všechny varianty.

Plnění dat:
- **Nové záznamy:** `push-case` ve STEJNÉM DeepSeek volání jako překlad+klasifikace
  detekuje jazyk a vrátí cs/de (fail-open na NULL → dobere backfill).
- **Staré záznamy (~5,4k):** `scripts/agent/backfill-resolution-i18n.mjs` — **záměrně
  přes Claude** (router task `translate` → claude:haiku, předplatné), ne DeepSeek, protože
  edge fn běží v cloudu bez Claude. Noční NON-FATAL Krok 3 v `run-agent-batch.ps1`
  (`--batch 15 --max 500`), resumovatelné (fronta = `resolution_lang IS NULL`). PATCHuje
  jen `resolution_cs/de/lang`, `resolution` se nikdy nedotkne.

Nasazení (TODO až proběhne): migraci 022 aplikovat **ručně přes dashboard SQL editor**
(DB porty 5432/6543 blokované z dev sítě, jako u 021; je idempotentní + DROP/CREATE
`known_fault_cases` kvůli rozšíření RETURNS TABLE); edge fn `push-case` + `known-faults`
přes `functions deploy`; staré záznamy dobere noční Claude backfill (nebo jednorázově
`node --env-file=… backfill-resolution-i18n.mjs`). Kryto testy
`tests/known-faults.test.js` (localizeResolution) a `tests/agent-resolution-i18n-backfill.test.js`.

Vědomě odložené / známé limity:
- ~42 % případů spadlo do `'other'` (číselník 118 závad nepokryje vše) — panel je
  nezobrazuje; lze zlepšit rozšířením číselníku (re-seed s víc položkami; pozor na
  8k-token strop DeepSeeku → seed cílí 70-90 položek a 3 vzorky/značku, aby se výstup vešel).
- Počty v `counts.all` mohou drobně nadhodnotit, kdyby jeden source_ref spadal do více
  pásem nájezdu (dedup je v rámci bucketu) — v praxi zanedbatelné (~90 % případů má prázdný nájezd).
- Anglické texty řešení se v detailu zobrazují bez překladu (v1).

### 0a. Průvodce opravou (web) — vedený postup po diagnóze, v2 (2026-06-11/12)

Nová funkce ve webové aplikaci (větev `feat/repair-guide`, PR #11): u každé závady v diagnóze
je tlačítko „Zahájit opravu". Model v2 vznikl po panelové revizi pěti person mechaniků
(veterán/junior/majitel/diagnostik/mobilní — skóre v1: 3-4/10, jednomyslná kritika), která
odhalila zásadní chybu v1: pole `řešení` jsou ALTERNATIVNÍ opravy, ne sekvence kroků.

Model v2 (`case.repairGuide`, `version: 2`) — tři fáze v řemeslně správném pořadí:
1. OVĚŘENÍ PŘÍČINY — `doporučené_testy` PŘED opravami (nejdřív měřit, pak měnit)
2. MOŽNÉ OPRAVY — mechanik VYBERE jednu akci („Provedu tuto opravu") → provede →
   „Pomohlo/Nepomohlo"; při úspěchu se zbylé označí „nebylo potřeba", při neúspěchu zkouší dál
3. ZÁVĚREČNÁ KONTROLA — výsledek „Vyřešeno" NEBO „Závada přetrvává" (neúspěch je platný konec)

Klíčová rozhodnutí v2:
- díly NEJSOU krok 1 — jen informační řádek „Může být potřeba… neobjednávejte předem"
- každý krok jde VRÁTIT (↺), dokud případ není uzavřen — ochrana proti mastnému prstu
- pokusy se NIKDY nemažou: nahrazení/ukončení archivuje do `case.repairGuideHistory`,
  v UI box „Předchozí pokusy" („nepomohlo: nucená regenerace…")
- `varování` z diagnózy se přenáší do hlavičky průvodce; výzva k ověření momentů je
  zvýrazněná přímo u rozpracované opravy (ne jen petitem v patičce)
- AI negeneruje žádné konkrétní hodnoty (momenty, náplně) — přijdou až z licencovaných dat
  (HaynesPro/TecRMI — fáze 2); původ návrhů značen badge (databáze s počtem shod vs. AI)
- `startedAt`/`completedAt`/`doneAt`/`chosenAt` slouží zároveň jako metrika používání funkce
- známé limity (vědomě odložené): offline režim pro mobilní mechaniky, OE čísla dílů,
  poznámky/naměřené hodnoty ke krokům, tisk zakázkového listu, ukládání neúspěchů do RAG

Soubory: `web/src/lib/repair-guide.js` (čistý stavový automat + unit testy v
`tests/unit.test.js`), `web/src/hooks/useRepairGuide.js`, `web/src/components/RepairGuideCard.jsx`,
zapojení v `DiagCard/SessionTimeline/SessionView/App/CaseDialogs`, i18n klíče `guide.*` (CS/EN/DE).
E2e test `web/e2e/core-flow.spec.js` pokrývá průchod průvodcem.

### 0. Toyota 2020-2024 byla dotažená do final reviewed subsetu, ale live import blokuje edge config

Nové artefakty:
- [nhtsa_2020_2024_toyota_ready_ai_reviewed_20260403](/C:/GB/tmp/nhtsa_2020_2024_toyota_ready_ai_reviewed_20260403)
- [nhtsa_2020_2024_toyota_reviewed_final_20260403](/C:/GB/tmp/nhtsa_2020_2024_toyota_reviewed_final_20260403)
- [nhtsa_2020_2024_toyota_dry_20260403](/C:/GB/tmp/nhtsa_2020_2024_toyota_dry_20260403)
- [seed_import_supabase_nhtsa_2020_2024_toyota_live_20260403](/C:/GB/seed_import_supabase_nhtsa_2020_2024_toyota_live_20260403)

Co se uzavřelo:
- Toyota coarse subset měl `356 ready` a `13851 to_review`, takže bezpečný postup byl jen ready-only individual AI review a pak ruční průchod accepted subsetu
- manuální review vyhodilo DCM/telematics firmware případy (`B15A804`, SOS LED, Toyota App, remote services, Wi-Fi) jako slabé software-only connected-services guidance
- infotainment / voice-recognition software update bulletiny byly vyhozené jako convenience guidance
- hybrid over-current MIL bulletin zůstal mimo final ready subset, protože seed pořád končil na generickém `follow the repair procedure`
- zůstala jediná čistá closed-case položka: Highlander Hybrid brake actuator internal leak (`C1391/C1252/C1256/C1253`)
- dry import prošel čistě `1/1`
- live import spadl na edge chybě `Alias ai_importer vyžaduje nastavený IMPORTER_USER_ID.`

Verdikt:
- Toyota reviewed subset je připravený
- před dalším live import retry je potřeba opravit `IMPORTER_USER_ID` konfiguraci v nasazené edge funkci `push-case` nebo import pustit s platným konkrétním UUID existujícího uživatele

### 1. Pontiac / Saturn / Saab legacy block byl uzavřen bez safe subsetu

Nové nebo změněné soubory:
- [scripts/tsb-seed-nhtsa.mjs](/C:/GB/scripts/tsb-seed-nhtsa.mjs)
- [web/src/constants/catalog-us.js](/C:/GB/web/src/constants/catalog-us.js)
- [web/src/constants/obd-codes.js](/C:/GB/web/src/constants/obd-codes.js)
- [tests/tsb-seed-nhtsa.test.js](/C:/GB/tests/tsb-seed-nhtsa.test.js)
- [tests/unit.test.js](/C:/GB/tests/unit.test.js)
- [NHTSA_STATUS.md](/C:/GB/NHTSA_STATUS.md)

Co se udělalo:
- do US katalogu byly opatrně přidané legacy passenger značky `Pontiac`, `Saturn` a `Saab`
- `Pontiac` a `Saturn` používají GM canonical OBD lookup přes `Chevrolet`
- `Saab` zůstává bez agresivního brand-specific OBD remapu; bere jen common/engine-tech vrstvu
- `Isuzu` truck řady `N/F/H/T-Series` jsou explicitně odfiltrované jako commercial-only
- `Geo` zůstal mimo katalog, protože celé observed modely (`Metro/Prizm/Tracker`) jsou pre-2000

Výsledek review:
- Pontiac: `240 reviewed`, `0 safe`
- Saturn: `111 reviewed`, `0 safe`
- Saab: `73 reviewed`, `0 safe`

Artefakty:
- [Pontiac MANUAL_REVIEW.md](/C:/GB/tmp/nhtsa_2025_pontiac_ai_reviewed_20260402/MANUAL_REVIEW.md)
- [Saturn MANUAL_REVIEW.md](/C:/GB/tmp/nhtsa_2025_saturn_ai_reviewed_20260402/MANUAL_REVIEW.md)
- [Saab MANUAL_REVIEW.md](/C:/GB/tmp/nhtsa_2025_saab_ai_reviewed_20260402/MANUAL_REVIEW.md)

Verdikt:
- tenhle legacy mainstream blok je uzavřený
- žádný live import se nedělal, protože nevznikl bezpečný subset

### 2. Mercedes-Maybach / Maybach / Mercedes / Smart unsupported block byl uzavřen

Nové nebo změněné soubory:
- [scripts/tsb-seed-nhtsa.mjs](/C:/GB/scripts/tsb-seed-nhtsa.mjs)
- [web/src/constants/catalog.js](/C:/GB/web/src/constants/catalog.js)
- [web/src/constants/catalog-us.js](/C:/GB/web/src/constants/catalog-us.js)
- [tests/tsb-seed-nhtsa.test.js](/C:/GB/tests/tsb-seed-nhtsa.test.js)
- [tests/unit.test.js](/C:/GB/tests/unit.test.js)
- [NHTSA_STATUS.md](/C:/GB/NHTSA_STATUS.md)

Co se uzavřelo:
- do katalogu/resolveru byly bezpečně přidané aliasy pro `Mercedes-Maybach`, `Maybach`, `Mercedes`, `Smart`, `Scion`, `Hummer`
- `Scion` a `Hummer` po individuálním review skončily na `0` safe seed
- malý safe alias blok byl naimportovaný:
  - `Maybach` `2`
  - `Mercedes` alias `6`
  - `Smart` `6`
- finální přísný individuální pass nad `Mercedes-Maybach` skončil na `64 ready`
- před live importem byly ještě odstraněny `2` semantické překryvy s dřívějším Mercedes blokem
- finální Mercedes-Maybach live import prošel `64/64`

Artefakty:
- finální reviewed subset: [nhtsa_2025_mercedes_maybach_reviewed_final_20260402](/C:/GB/tmp/nhtsa_2025_mercedes_maybach_reviewed_final_20260402)
- audit: [MANUAL_REVIEW.md](/C:/GB/tmp/nhtsa_2025_mercedes_maybach_reviewed_final_20260402/MANUAL_REVIEW.md)
- dry import: [results.jsonl](/C:/GB/seed_import_supabase_nhtsa_2025_mercedes_maybach_dry_20260402_r2/results.jsonl)
- live import: [results.jsonl](/C:/GB/seed_import_supabase_nhtsa_2025_mercedes_maybach_live_20260402/results.jsonl)

### 3. Mercedes NHTSA mapping a safe subset byly zpřísněny

Nové nebo změněné soubory:
- [scripts/tsb-seed-nhtsa.mjs](/C:/GB/scripts/tsb-seed-nhtsa.mjs)
- [web/src/constants/catalog.js](/C:/GB/web/src/constants/catalog.js)
- [tests/tsb-seed-nhtsa.test.js](/C:/GB/tests/tsb-seed-nhtsa.test.js)
- [tests/unit.test.js](/C:/GB/tests/unit.test.js)

Co je nové:
- do Mercedes katalogu byly doplněny `Sprinter VS30`, `AMG GT C190 / R190` a `AMG GT X290`
- NHTSA resolver už nemapuje US fleet názvy `SPRINTER 1500/2500/3500/4500` slepě na `VS30`; alias je nově year-gated jen pro `MY2019+`
- explicitní `SPRINTER (VS30)` se dál mapuje přímo na `Sprinter VS30`
- tím se omezuje chybné přemapování starších US Sprinter bulletinů do nové generace

Aktuální Mercedes NHTSA stav:
- po přísném individuálním třetím passu vznikl high-confidence subset `185 ready`
- working subset je v [nhtsa_2025_mercedes_thirdpass_safe_20260401](/C:/GB/tmp/nhtsa_2025_mercedes_thirdpass_safe_20260401)
- audit je v [MANUAL_REVIEW.md](/C:/GB/tmp/nhtsa_2025_mercedes_thirdpass_safe_20260401/MANUAL_REVIEW.md)
- subset už byl čistě naimportovaný `185/185`

### 3b. Lincoln 2020-2024 byl uzavřen druhým přísným AI passem

Nové nebo změněné soubory:
- [scripts/tsb-second-pass-nhtsa-ai.mjs](/C:/GB/scripts/tsb-second-pass-nhtsa-ai.mjs)
- [tests/tsb-second-pass-nhtsa-ai.test.js](/C:/GB/tests/tsb-second-pass-nhtsa-ai.test.js)
- [NHTSA_STATUS.md](/C:/GB/NHTSA_STATUS.md)

Co je nové:
- nový druhý-pass skript znovu reviewuje už AI-vyčištěné `ready + to_review`
- explicitně shazuje:
  - generic symptom tagy
  - conditional/decision-tree opravy
  - slabé software-only comfort/convenience bulletiny
- Lincoln 2020-2024 tak spadl z prvního AI výsledku `368 accepted` na finální safe subset `139`

Artefakty:
- finální Lincoln subset: [nhtsa_2020_2024_lincoln_reviewed_final_20260402](/C:/GB/tmp/nhtsa_2020_2024_lincoln_reviewed_final_20260402)
- audit: [MANUAL_REVIEW.md](/C:/GB/tmp/nhtsa_2020_2024_lincoln_reviewed_final_20260402/MANUAL_REVIEW.md)
- dry import: [results.jsonl](/C:/GB/tmp/nhtsa_2020_2024_lincoln_dry_20260402/results.jsonl)
- live import: [results.jsonl](/C:/GB/seed_import_supabase_nhtsa_2020_2024_lincoln_live_20260402/results.jsonl)

### 3c. Infiniti a Audi 2020-2024 byly dotažené do čistého importu

Nové nebo změněné soubory:
- [web/src/constants/catalog-us.js](/C:/GB/web/src/constants/catalog-us.js)
- [tests/unit.test.js](/C:/GB/tests/unit.test.js)
- [NHTSA_STATUS.md](/C:/GB/NHTSA_STATUS.md)

Co je nové:
- US katalog pro `Infiniti` byl opatrně rozšířen o legacy modely:
  - `G25`, `G35`, `G37`
  - `M35`, `M45`, `M37`, `M56`
  - `JX35`, `QX56`, `QX30`, starší `QX50`
- Infiniti second-pass review tak mohl zachránit validní starší EVAP/mechanical případy, které předtím padaly jen na unresolved model
- `Audi` coarse subset byl extrémně přestřelený, proto jsem nepouštěl AI nad `100k` review kandidátů; místo toho šel:
  - coarse `ready`
  - first-pass AI
  - second-pass strict per-case AI
  - teprve potom import

Výsledek:
- Infiniti `30/30` clean import
- Audi `25/25` clean import

Artefakty:
- Infiniti final subset: [nhtsa_2020_2024_infiniti_second_pass_20260403](/C:/GB/tmp/nhtsa_2020_2024_infiniti_second_pass_20260403)
- Infiniti live import: [results.jsonl](/C:/GB/seed_import_supabase_nhtsa_2020_2024_infiniti_live_20260403/results.jsonl)
- Audi final subset: [nhtsa_2020_2024_audi_second_pass_20260402](/C:/GB/tmp/nhtsa_2020_2024_audi_second_pass_20260402)
- Audi live import: [results.jsonl](/C:/GB/seed_import_supabase_nhtsa_2020_2024_audi_live_20260402/results.jsonl)

### 4. Seed metadata teď nesou původní URL vlákna

Do seed recordů bylo doplněno `thread_url`, takže každá nová položka jde zpětně ručně zkontrolovat proti originálnímu vláknu.

Dotčené vrstvy:
- [scripts/forum-seed.mjs](/C:/GB/scripts/forum-seed.mjs)
- importér [scripts/import-seeds-to-supabase.mjs](/C:/GB/scripts/import-seeds-to-supabase.mjs)
- edge `push-case` [push-case/index.ts](/C:/GB/supabase/functions/push-case/index.ts)
- edge `search-cases` [search-cases/index.ts](/C:/GB/supabase/functions/search-cases/index.ts)
- migrace [009_add_thread_url_to_cases.sql](/C:/GB/supabase/migrations/009_add_thread_url_to_cases.sql)

### 5. Audi crawler byl dokončen a opraven

Nové nebo změněné soubory:
- [scripts/forum-seed-audi.mjs](/C:/GB/scripts/forum-seed-audi.mjs)
- [tests/forum-seed-audi.test.js](/C:/GB/tests/forum-seed-audi.test.js)

Původní copy-paste problém:
- record assembly ještě používala Peugeot logiku a nedefinované `PEUGEOT_ENTRY`

Po opravě:
- malý smoke běh prošel
- signals retry běh `seed_audi_full_signals_retry_20260321_204709` po ruční kontrole skončil na `5 ready`
- audit je v [MANUAL_REVIEW.md](/C:/GB/seed_audi_full_signals_retry_20260321_204709/MANUAL_REVIEW.md)

### 5. Připraveny nové root crawlery pro Opel, BMW, SEAT a Citroën

Sdílený základ:
- [scripts/forum-seed-club-root.mjs](/C:/GB/scripts/forum-seed-club-root.mjs)

Nové wrappery:
- [scripts/forum-seed-opel.mjs](/C:/GB/scripts/forum-seed-opel.mjs)
- [scripts/forum-seed-bmw.mjs](/C:/GB/scripts/forum-seed-bmw.mjs)
- [scripts/forum-seed-seat.mjs](/C:/GB/scripts/forum-seed-seat.mjs)
- [scripts/forum-seed-citroen.mjs](/C:/GB/scripts/forum-seed-citroen.mjs)

Nové testy:
- [tests/forum-seed-opel.test.js](/C:/GB/tests/forum-seed-opel.test.js)
- [tests/forum-seed-bmw.test.js](/C:/GB/tests/forum-seed-bmw.test.js)
- [tests/forum-seed-seat.test.js](/C:/GB/tests/forum-seed-seat.test.js)
- [tests/forum-seed-citroen.test.js](/C:/GB/tests/forum-seed-citroen.test.js)

Pravidla těchto crawlerů:
- root discovery z klubového rootu
- pouze modely, které začaly od roku 2000
- generické family fórum radši vrací `model_family` než agresivní konkrétní generaci
- nové modely v katalogu se nemají přidávat jen podle názvu fóra; musí být ověřené z více důvěryhodných zdrojů

### 6. Připraven sekvenční batch runner pro více klubů

Nové soubory:
- [scripts/forum-seed-batch.mjs](/C:/GB/scripts/forum-seed-batch.mjs)
- [tests/forum-seed-batch.test.js](/C:/GB/tests/forum-seed-batch.test.js)

Batch runner defaultně spouští:
- `https://www.citroen-club.cz/forum`
- `https://www.bmw-club.cz/forum`
- `https://www.club-opel.com/forum`
- `https://www.seatclub.cz/forum`

Je sekvenční, ne paralelní, aby byly čitelné logy a nerozbily se rate limity.

Poznámka k aktuálnímu stavu:
- při prvním batch discovery běhu byl nalezen a opraven blocker v root discovery: kategorie se předávaly do inventory pod špatnými klíči `forum_url/forum_title` místo `forumUrl/forumTitle`
- po tomto fixu je potřeba discovery nad těmito čtyřmi kluby pustit znovu

### 7. NHTSA 2025 pipeline je aktuálně dotažená pro Volvo

Nové nebo změněné soubory:
- [scripts/tsb-seed-nhtsa.mjs](/C:/GB/scripts/tsb-seed-nhtsa.mjs)
- [web/src/constants/catalog-us.js](/C:/GB/web/src/constants/catalog-us.js)
- [tests/tsb-seed-nhtsa.test.js](/C:/GB/tests/tsb-seed-nhtsa.test.js)
- [tests/unit.test.js](/C:/GB/tests/unit.test.js)
- [NHTSA_STATUS.md](/C:/GB/NHTSA_STATUS.md)

Co se udělalo:
- Volvo parser nově odfiltruje truck řady `VN/VNL/VNR/VHD/VAH/VT` ze passenger-car slice.
- US katalog se rozšířil o bezpečně ověřený `V90 (2017–present)`.
- Alias resolver teď bezpečně mapuje `XC40MHEV/XC40BEV/EX40/EC40`, `XC60/90 MHEV/PHEV`, `S60/S90 MHEV/PHEV`, `V60/V90` a cross-country varianty tam, kde je pro ně oficiální US opora.
- Finální Volvo subset po individuálním AI + manual review skončil na `32 ready`, `0 to_review`, `7 rejected_review`.
- Rejected byly hlavně:
  - `V60CCPHEV` unresolved případy bez dost pevné US katalogové opory
  - navigation map bulletiny, kde Volvo samo píše, že jde jen o dočasný reset/workaround a teprve připravuje budoucí countermeasure
- Import log:
  - [seed_import_supabase_nhtsa_2025_volvo_live_20260331/results.jsonl](/C:/GB/seed_import_supabase_nhtsa_2025_volvo_live_20260331/results.jsonl)

### 8. Live Supabase testy jsou rozdělené do procesních suite

Původní monolitický live test v [tests/supabase-integration.test.js](/C:/GB/tests/supabase-integration.test.js) byl rozdělen na harness + suite:

- shared harness: [tests/supabase-live/harness.js](/C:/GB/tests/supabase-live/harness.js)
- CRUD + privacy: [tests/supabase-live/suites/web-sessions.js](/C:/GB/tests/supabase-live/suites/web-sessions.js)
- RLS: [tests/supabase-live/suites/rls.js](/C:/GB/tests/supabase-live/suites/rls.js)
- edge functions + `gearbrain_cases`: [tests/supabase-live/suites/edge-functions.js](/C:/GB/tests/supabase-live/suites/edge-functions.js)

Tento refaktor stále čeká na první plný lokální běh.

## Jak jsou live Supabase testy zamýšlené

Cíl není mockovat Supabase, ale ověřit skutečné kritické toky:

- login test usera
- CRUD nad `gearbrain_web_sessions`
- že se VIN/SPZ do cloudu neukládají
- `push-case`
- `search-cases`
- `send-feedback`
- základní validace `deepseek-proxy`
- anon restrikce
- volitelně cross-user RLS

### Aktuální autentizační model live testů

Harness očekává **email + heslo** test usera, ne OAuth login přes GitHub.

To znamená:
- GitHub-only účet pro tyto live testy nestačí
- je potřeba vytvořit samostatného test usera v Supabase Auth

## Jak live testy pustit

Požadované env:
- `TEST_SUPABASE_URL`
- `TEST_SUPABASE_ANON_KEY`
- `TEST_USER_EMAIL`
- `TEST_USER_PASSWORD`

Volitelně:
- `TEST_SECOND_USER_EMAIL`
- `TEST_SECOND_USER_PASSWORD`

Příklad:

```powershell
Set-Location C:\GB

$env:TEST_SUPABASE_URL="https://nmvjthfezyjcwuzphiuu.supabase.co"
$env:TEST_SUPABASE_ANON_KEY="SEM_VLOZ_ANON_KEY"
$env:TEST_USER_EMAIL="gb-test-user@drivecodex.local"
$env:TEST_USER_PASSWORD="SEM_VLOZ_TEST_HESLO"

& "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd" run test:supabase:live
```

## Praktické příkazy relevantní teď

### Batch discovery pro Citroën/BMW/Opel/SEAT

```powershell
Set-Location C:\GB
$stamp = Get-Date -Format yyyyMMdd_HHmmss
& "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd" run forum:seed:batch -- `
  "seed_batch_clubs_titles_$stamp" `
  --discover-only --index-pages 999 --min-posts 2 --sleep-ms 400
```

### Batch signals běh

```powershell
Set-Location C:\GB
$env:DEEPSEEK_API_KEY="TVUJ_KLIC"
$stamp = Get-Date -Format yyyyMMdd_HHmmss
& "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd" run forum:seed:batch -- `
  "seed_batch_clubs_full_$stamp" `
  --signals-only --keep-review --index-pages 999 --pages 3 --sleep-ms 400 --min-posts 2
```

### Audi import

Aktuální bezpečný Audi dataset:
- [seed_audi_full_signals_retry_20260321_204709](/C:/GB/seed_audi_full_signals_retry_20260321_204709)

Import:

```powershell
Set-Location C:\GB
$stamp = Get-Date -Format yyyyMMdd_HHmmss
& "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd" run seed:import:supabase -- `
  "C:\GB\seed_audi_full_signals_retry_20260321_204709" `
  --user-id "8463d502-7bf6-464b-9fb2-e6dec5b9d4d3" `
  --sleep-ms 200 `
  --out-dir "seed_import_supabase_audi_retry_$stamp"
```

## Důležité externí závislosti a secrets

Web / runtime:
- Supabase URL
- Supabase anon key

Seed crawlery:
- `DEEPSEEK_API_KEY`

Autonomní crawl agent (`scripts/agent/`):
- AI volání jdou přes router `scripts/agent/llm.mjs` — výchozí nastavení:
  klasifikace+extrakce+kalibrace+deník = Claude Code CLI (předplatné, nutné
  jednorázové přihlášení `claude` v terminálu), verifikace = DeepSeek
  (`DEEPSEEK_API_KEY`) jako nezávislý auditor od jiného výrobce
- přesměrování per úloha: `AGENT_LLM_<TASK>=provider:model`
  (např. `AGENT_LLM_VERIFY=claude:opus` pro provoz úplně bez DeepSeeku)
- vyčerpání limitu = automatická pauza do resetu okna (tabulka `agent_meta`,
  soubor `pause-until.txt`), plánované běhy se levně přeskakují a po resetu
  se agent sám rozjede. Soubor na ploše `DRIVECODEX-CRAWLER-STOJI-PRECTI-ME.txt`
  se objeví, když poslední čistý běh byl >24h a zároveň >6h po slíbeném resetu
  (nebo bezpodmínečně po >9 dnech); sám zmizí po ozdravení
- vypršené přihlášení Claude = `AuthError`: agent se zastaví bez pauzy (re-login
  musí udělat člověk), takže alarm dorazí; `ANTHROPIC_API_KEY` v prostředí
  plánovače NENASTAVOVAT (přepnulo by účtování na placené API)
- **discovery (fáze 1):** `discover.mjs` hledá fóra přes Claude web search
  (`--allowedTools WebSearch`), triage + dedup, zařadí jako `discovered` ke
  kalibraci. Škrcené: jen při málo nakalibrovaných fórech, 1× za proces, 24h
  interval; vypínač `AGENT_DISABLE_LIVE_DISCOVERY=1`
- **online registr** `crawl_forums` (Supabase, migrace 020) = sdílený seznam fór
  + stav „naposled scrapováno"; přístup `forum-registry.mjs` přes service key.
  Bez klíče běží lokálně. Discovery zapisuje `mode:'ignore'` (nepřepíše aktivní
  fórum), crawl `mode:'merge'` (aktualizuje stav)
- **secrets:** git-ignored `scripts/agent/.env.local` (viz `.env.local.example`)
  — `SUPABASE_SERVICE_KEY` (formát `sb_secret_…`), `SUPABASE_DB_PASSWORD`.
  `run-agent-batch.ps1` je načítá automaticky
- **provozní gotcha:** firemní síť blokuje DB port 5432, takže `supabase db push`
  odsud nejede — **migrace schématu se dělají přes dashboard SQL editor**. Běžný
  provoz (registr/import/crosscheck) jde přes HTTPS/443 a funguje. Pomocník na
  migrace (mimo firewall): `scripts/agent/apply-migrations.ps1`
- **stav:** agent NENÍ na plánovači (`register-agent-task.ps1` nespuštěn) —
  časovaný provoz je potřeba zapnout
- detail: `scripts/agent/README.md`

Edge functions:
- `DEEPSEEK_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- pro `push-case` může být relevantní `IMPORTER_USER_ID`
- pro `send-feedback` může být relevantní `RESEND_API_KEY`

Live tests:
- `TEST_SUPABASE_URL`
- `TEST_SUPABASE_ANON_KEY`
- `TEST_USER_EMAIL`
- `TEST_USER_PASSWORD`
- volitelně druhý test user

## Co si neplést se source of truth

V rootu repa jsou seed výstupy, review adresáře a deploy artefakty. Jsou užitečné jako data/debug artefakty, ale nejsou to zdrojové moduly aplikace.

Historické dokumenty:
- [PROJECT_HANDOVER_2026-03-19.md](/C:/GB/PROJECT_HANDOVER_2026-03-19.md) je starý snapshot
- tento [handover.md](/C:/GB/handover.md) má být aktuální pracovní přehled

## Doporučené další kroky

1. Znovu pustit batch discovery pro `Citroën/BMW/Opel/SEAT` po fixu root discovery.
2. Rozhodnout, které z necommitnutých crawler změn opravdu mají jít do commitu před push do `main`.
3. Pushnout Audi commit a případně nový crawler/batch commit do `origin/codex/prepare-main-merge`, teprve potom řešit merge do `main`.
4. Dotáhnout první úspěšný běh `test:supabase:live`.
4. Až live testy budou stabilní, přidat app-layer contract testy pro:
   - [web/src/lib/storage-sessions.js](/C:/GB/web/src/lib/storage-sessions.js)
   - [web/src/lib/storage-edge.js](/C:/GB/web/src/lib/storage-edge.js)
5. ✅ Hotovo — browser E2E smoke flow běží přes Playwright: `web/e2e/core-flow.spec.js`
   (login → nový případ → diagnostika → uzavření/uložení → ověření v DB → úklid).
   AI je v testu nahrazeno deterministickou „canned" odpovědí (dvojitě zahradzeno: jen dev build +
   explicitní flag `VITE_TEST_MODE`/`localStorage dc_test_mode`, takže v produkci se nikdy nespustí).
   Spouští se v CI jako job `web-e2e`. Detaily v `TEST_SETUP.md`.

## Kdybych na to navazoval znovu já

Začal bych tímto:

```powershell
Set-Location C:\GB
git status --short
& "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd" run forum:seed:renault -- "seed_renault_titles_$(Get-Date -Format yyyyMMdd_HHmmss)" --discover-only --index-pages 999 --min-posts 2 --sleep-ms 400
```

Pak bych řešil první konkrétní výsledek v tomto pořadí:
- správnost discovery inventory a kept ratio
- až potom první `signals-only` crawl
- vedle toho nezávisle první reálný běh `test:supabase:live`
