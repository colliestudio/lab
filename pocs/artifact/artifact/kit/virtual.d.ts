declare module "artifact:registry" {
  import type { Registry } from "./registry.ts";
  const registry: Registry;
  export default registry;
}
declare module "*.css";
declare module "*.png" { const url: string; export default url }
declare module "*.jpg" { const url: string; export default url }
declare module "*.jpeg" { const url: string; export default url }
declare module "*.gif" { const url: string; export default url }
declare module "*.webp" { const url: string; export default url }
declare module "*.svg" { const url: string; export default url }
declare module "*.patch" { import type { PatchFile } from "./registry.ts"; const files: PatchFile[]; export default files }
declare module "*.replay" { const b64: string; export default b64 }
declare module "*.css?text" { const css: string; export default css }
