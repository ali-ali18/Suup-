// O que é um arquivo que o bot entrega (`send_file`) vive em `@suup/core` (o servidor detecta o
// tipo com as mesmas tabelas); a API só expõe a lista de tipos ao app. Importa o subcaminho
// `@suup/core/files` (tabelas e funções puras, sem módulo do Node) e não o índice do core.
export { FILE_KINDS, type FileKind } from "@suup/core/files";
