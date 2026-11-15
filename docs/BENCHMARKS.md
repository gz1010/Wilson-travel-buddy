# Bonsai-2 benchmarks

Fill in during hour one on the Apple Silicon Mac (and the Intel Mac for 2B).
Read `timings.prompt_ms` and `timings.predicted_per_second` from a
`llama-server` response, or run `cd app && npm run test:live`, which runs the
app's own trip setup, recommendations, guide and translator against the
running server and writes every answer and timing to
`app/src/core/__live__/last-run.json`.

| Machine | Model | Tokens/s | Time to first token | 12-word EN→ES translation | Trip JSON valid (5 tries) |
|---|---|---|---|---|---|
| Apple Silicon Mac (A) | 2B | | | | |
| Apple Silicon Mac (A) | 4B | | | | |
| Apple Silicon Mac (A) | 9B | | | | |
| B's Windows PC, Intel Core Ultra 9 386H, **CPU only** | 4B | ~15 | 0.6 s (translate), 6–10 s (recommend, ~450-token prompt) | 2.7 s | 5/5 (8–11 s each) |

The Windows row is a floor, not a target: no GPU, and prompt processing runs
at about 45 tokens/s on the CPU, which is what makes recommendations slow
there. The Mac's Metal build should be several times faster; the "refresh
under 3 s" and "first audio within 2.5 s" checks have to be timed on A.

Measured 14 Nov 2026 with PrismML's `llama-server` (release
prism-b10828-a153697) and `Ternary-Bonsai-2-4B-PQ2_0.gguf`, thinking off.

### Server flags: do not use `--reasoning-format none` with Bonsai-2

With that flag, the empty `<think></think>` block Bonsai-2's template opens
every reply with comes through as text, and **every JSON-schema request fails**
with `400 Unexpected empty grammar stack after accepting piece: <think>` (trip
setup errors; recommendations silently fall back to code-written reasons).
PrismML's generic launcher passes that flag; its Bonsai-2 profile (what
`scripts/start.sh` uses on the Mac) does not. On Windows use
`scripts/start-llama-windows.ps1`. The app's client also strips a leading
think block (`ThinkFilter` in `app/src/services/llm/llamaClient.ts`).

## Translation check (10 sentences each way)

Graded by B. ✓ = correct and natural; ~ = understandable, small error.

| Sentence | 2B | 4B | Notes |
|---|---|---|---|
| Could you tell me how to get to the cathedral from here? | | ✓ ¿Podrías decirme cómo llegar a la catedral desde aquí? | |
| Is this table free? | | ✓ ¿Está esta mesa libre? | |
| We would like two glasses of red wine, please. | | ~ Quisiera dos copas de vino tinto, por favor. | "we" became "I" (quisiéramos) |
| What time does the last bus to the airport leave? | | ✓ ¿A qué hora sale el último autobús al aeropuerto? | |
| I booked a room for three nights under the name Smith. | | ✓ Reservé una habitación por tres noches bajo el nombre Smith. | "a nombre de" is more idiomatic |
| Is there a pharmacy open near here at this hour? | | ~ …abierta cerca de aquí en esta hora? | "a esta hora" |
| Can I pay by card? | | ✓ ¿Puedo pagar con tarjeta? | |
| My phone has no signal, can I use your wifi? | | ✓ Mi teléfono no tiene señal, ¿puedo usar tu WiFi? | informal "tu" |
| Which of these tapas do you recommend? | | ~ ¿Cuál de estos tapas te recomendarías? | "estas tapas", "me recomienda" |
| Excuse me, I think there is a mistake in the bill. | | ~ …un error en la factura. | "la cuenta" in a bar |
| Está a cinco minutos andando, todo recto por esta calle. | | ✓ It's five minutes away, walking straight down this street. | |
| Sí, siéntese donde quiera. | | ✓ Yes, feel free to sit wherever you like. | |
| ¿Quieren algo de comer o solo beber? | | ✓ Do you want something to eat or just a drink? | |
| El último autobús sale a las once y media. | | ✓ The last bus leaves at 11:30. | |
| Lo siento, la cocina cierra a las cuatro. | | ✓ Sorry, the kitchen closes at four. | |
| Hay una farmacia de guardia en la plaza. | | ✓ There's an on-call pharmacy in the square. | |
| Sí, aceptamos tarjeta. | | ✓ Yes, we accept cards. | |
| La contraseña está en el ticket. | | ✓ The password is in the ticket. | "on the receipt" |
| Le recomiendo las espinacas con garbanzos. | | ✓ I recommend spinach with chickpeas. | |
| Perdone, ahora mismo se lo corrijo. | | ✓ Sorry, I'll correct that right now. | |

**4B verdict: go for Spanish.** Spanish→English 10/10; English→Spanish 6/10
perfect and 4/10 with small slips a local would still understand. Each
sentence took 1–3 s on B's CPU. Exact phrasebook matches skip the model.
