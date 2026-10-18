// 宿主包类型声明：真宿主挂着 @deepseek-ai/dsh-tools 时以真实类型为准（动态 import）；
// 离线环境无该包，这里给出契约声明以保证类型检查可过。
declare module "@deepseek-ai/dsh-tools" {
  export function defineTool(definition: any): any;
}
