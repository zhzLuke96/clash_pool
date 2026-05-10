import { defineConfig } from "tsup";

// prettier-ignore
export default defineConfig({
  entry: ['index.ts'],        // 入口文件（按需修改）
  format: ['cjs'],            // 输出 CommonJS 格式（Node.js 常用）
  splitting: false,           // 禁用代码分割，合并为一个文件
  clean: true,                // 构建前清空输出目录
  platform: 'node',           // 目标平台为 Node.js
  target: 'node22',           // 根据你的 Node 版本调整
  sourcemap: false,           // 是否需要 sourcemap（按需开启）
  bundle: true,               // 打包所有依赖（默认 true）
  noExternal: [ /(.*)/ ]
})
