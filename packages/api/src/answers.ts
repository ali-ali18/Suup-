// O texto da resposta a uma pergunta do bot vive em `@suup/core` (o laço, que lê toda resposta,
// usa as mesmas funções); a API só o expõe ao app, à CLI e ao servidor. Importa o subcaminho
// `@suup/core/answers` (só texto, sem módulo do Node) e não o índice do core: o app de desktop
// importa este arquivo direto e o índice do core puxaria módulos que o navegador não tem.
export {
  buildAnswerText,
  isStructuredAnswer,
  oneLine,
  optionLetter,
  parseAnswerText,
  type QuestionAnswer,
  resolveOptionAnswer,
  SKIPPED,
} from "@suup/core/answers";
