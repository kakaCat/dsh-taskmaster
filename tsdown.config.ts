import { defineConfig } from "tsdown";

// 打包出宿主插件 bundle：dist/index.mjs（loader 按包名加载 main 入口）
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  outDir: "dist",
  dts: false,
  clean: true,
  // 宿主包由运行时提供，不打进 bundle
  external: [/^@deepseek-ai\//, "js-yaml"],
});
