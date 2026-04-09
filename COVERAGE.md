# Coverage

This document describes what data the Hungarian Data Protection MCP indexes and what it does not cover.

## Data Sources

| Source | Type | URL |
|--------|------|-----|
| NAIH Határozatok | Decisions, sanctions, warnings | https://naih.hu/ |
| NAIH Tájékoztatók & Iránymutatások | Guidance, recommendations | https://naih.hu/ |

## Decision Coverage

NAIH (Nemzeti Adatvédelmi és Információszabadság Hatóság) formal decisions:

- **Bírságok** — monetary penalties (fines) under GDPR Article 83
- **Figyelmeztetések** — formal warnings under GDPR Article 58(2)(b)
- **Határozatok** — binding decisions including corrective measures
- **Tájékoztatók** — informational decisions and closures

Coverage begins from NAIH's establishment as the GDPR supervisory authority in 2018. Earlier decisions under the predecessor authority (Adatvédelmi Biztos) are not included.

## Guidance Coverage

| Type | Description |
|------|-------------|
| Tájékoztató | General information notices on GDPR topics |
| Iránymutatás | Guidance documents aligned with EDPB guidelines |
| Állásfoglalás | Position papers and opinions |
| Útmutató | Practical how-to guides |

## Topic Coverage

| Topic ID | Hungarian | English |
|----------|-----------|---------|
| consent | Hozzájárulás | Consent |
| cookies | Sütik | Cookies |
| transfers | Adattovábbítás | International transfers |
| dpia | Adatvédelmi hatásvizsgálat | DPIA |
| breach_notification | Adatvédelmi incidens | Breach notification |
| privacy_by_design | Beépített adatvédelem | Privacy by design |
| employee_monitoring | Munkahelyi adatvédelem | Employee monitoring |
| health_data | Egészségügyi adatok | Health data |
| children | Gyermekek adatai | Children's data |

## What Is Not Covered

- Decisions by the predecessor authority (Adatvédelmi Biztos, pre-2018)
- Court appeals of NAIH decisions
- EDPB/CJEU case law (separate MCPs)
- Hungarian sector-specific regulators (e.g., MNB, NMHH)
- Real-time updates — data is scraped periodically

## Data Freshness

Data is scraped from naih.hu on a scheduled basis. Use `hu_dp_check_data_freshness` to query the current status, or check the [ingest workflow](.github/workflows/ingest.yml).
