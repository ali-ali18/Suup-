-- 0035_bot_color_palette: a paleta de cores dos bots mudou (o cinza-escuro "grafite" saiu: quase não
-- aparecia no fundo escuro). O banco guarda só o id da cor, então os bots que usavam `grafite` passam
-- a usar `cinza`, o mais parecido que continua na paleta. As demais cores não mudam de id.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.

update bots set color = 'cinza' where color = 'grafite';
