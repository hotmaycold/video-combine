import { buildApi } from "./server";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
const app = buildApi();

await app.listen({ port, host });
console.log(`video-combine API listening on http://${host}:${port}`);
