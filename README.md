# Chatbot ISP Mantovani

Chatbot web gratuito para responder preguntas de aspirantes e ingresantes del
instituto (carreras, requisitos, fechas, contacto).

## Estructura

- `frontend/` → página del chat (HTML/CSS/JS puro, sin frameworks)
- `api/chat.js` → función serverless que llama a la API de Gemini
- `data/institucion.json` → contenido del instituto (lo genera el scraper)
- `scraper/scrape.js` → script que recorre la web del instituto y arma `institucion.json`
- `.github/workflows/scraping.yml` → automatización que corre el scraper periódicamente

## Estado del proyecto

- [x] Paso 1: API key de Gemini
- [x] Paso 2: repo en GitHub
- [x] Paso 3: estructura de carpetas
- [ ] Paso 4: scraper
- [ ] Paso 5: función serverless (api/chat.js)
- [ ] Paso 6: frontend
- [ ] Paso 7: deploy en Vercel
- [ ] Paso 8: GitHub Actions
- [ ] Paso 9: pruebas y ajustes

## Variables de entorno necesarias (se configuran en Vercel, NUNCA en el código)

- `GEMINI_API_KEY` → la key generada en Google AI Studio
