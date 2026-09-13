# tools/og — a arte do preview

`apps/web/public/og.png` é o cartão que WhatsApp, X e Slack mostram quando
alguém compartilha um link do app (issue #38). Binário sem fonte apodrece, então
a fonte fica aqui: `og.html`, uma página de 1200×630 renderizada pelo Chrome que
já está instalado para o `run-watchlytics`.

Regerar, da raiz do repositório:

```bash
google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --screenshot=apps/web/public/og.png --window-size=1200,630 \
  "file://$PWD/tools/og/og.html"
```

Confira o tamanho depois: acima de ~300 KB o WhatsApp costuma ignorar a imagem e
o cartão volta a sair só com texto.

**A mesma arte para todo perfil, de propósito.** Pôster da biblioteca da pessoa
sairia mais bonito e custaria zero infra — o `poster_url` já está no banco —, mas
quem busca o preview é o servidor do mensageiro, não o navegador de quem clica:
a imagem viraria "o que fulano assistiu" no cache de um terceiro. A decisão está
no issue #38 e o texto do card não fala de ninguém.
