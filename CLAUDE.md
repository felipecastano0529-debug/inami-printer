# Inami Ice Cream Shop · impresora — contexto para Claude

> Generado por la Torre de Control de fily&co desde `catalogo/catalogo.yaml`
> (instancia `inami-printer`). Amplíalo a mano con lo que haga falta saber de este
> código; la tabla se puede regenerar.

## Esta instancia

| | |
|---|---|
| Cliente | Inami Ice Cream Shop · impresora |
| Plataforma | Pida Pues |
| Instancia (Torre) | `inami-printer` |
| Estado | produccion |
| Rama de producción | `main` |
| Supabase | no usa |
| Vercel | — |
| Dominio | — |

## Reglas

1. **Esta instancia es independiente.** Su repo, su base y su Vercel no se
   comparten con ningún otro cliente, aunque la plataforma sea la misma. Un
   cambio aquí no se copia a otro cliente sin que fily lo pida.
2. Vercel no está conectado a este repo: producción se despliega a mano. No asumas que un merge publica nada.
3. Las migraciones de base de datos van solo contra la base de esta instancia
   y nunca se corren contra producción sin que fily lo apruebe.
4. Secretos solo en variables de entorno (Vercel / `.env.local`). Nunca en el código ni en commits.
5. Diseño: si hay `DESIGN.md`, manda. Si no, la skill `filyanco-desing`.
6. Si hay bot de WhatsApp/Instagram: skills `fily-bot` / `bot-fily-co`. Los bots que facturan no se tocan sin aprobación.

## Problemas conocidos

- el repo `inami-printer` es PÚBLICO
