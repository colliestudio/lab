import { main } from "./main.ts";
main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error("error: " + (e?.message ?? e)); process.exit(1); });
