"""suup_docs: an optional helper that makes PDF, Word and Excel files with Suup's guardrails.

You may write your own code instead. These are the rules every file you hand to the user passes
(send_file opens the file and refuses it when one fails):

  * A4 pages, UTF-8 text, margins of at least 1.5 cm at the sides and 1 cm at the top and bottom.
  * PDF: every font is a TrueType font that is REGISTERED and EMBEDDED. Never the 14 standard fonts
    (Helvetica, Times-Roman, Courier): the file does not carry them. This module registers two
    free fonts with full Portuguese coverage (Liberation Serif and Liberation Sans, SIL OFL).
  * xlsx: formulas without errors, real numbers (not "R$ 10,00" as text) and real number formats.
  * Academic work (ABNT): margins 3/2/2/3 cm (top/right/bottom/left), 12 pt, line spacing 1.5,
    justified text, first-line indent 1.25 cm, a figure caption "Figura 1 – title" with
    "Fonte: ..." on the next line.

PDF (reportlab, with the fonts and styles already set):

    import suup_docs as sd
    doc, st = sd.pdf("relatorio.pdf", title="Relatório", abnt=False)   # abnt=True for ABNT
    story = [sd.Paragraph("Relatório", st["h1"]), sd.Paragraph("Texto...", st["body"]),
             sd.table([["Região", "Vendas"], ["Sul", "120"]], st)]
    sd.build(doc, story)                                                # then send_file

Word (python-docx, page, margins and font already set):

    d = sd.docx("trabalho.docx", abnt=True)     # a python-docx Document
    d.add_paragraph("Texto...")                 # the Normal style carries the font and spacing
    d.save("trabalho.docx")

Excel (openpyxl, with number formats):

    wb, ws = sd.xlsx()
    ws.append(["Produto", "Qtd", "Preço", "Total"])
    ws.append(["Caneta", 3, 2.5, "=B2*C2"])
    sd.format_column(ws, "C", sd.CURRENCY); sd.format_column(ws, "D", sd.CURRENCY)
    wb.save("planilha.xlsx")
"""

from __future__ import annotations

import os

from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

__all__ = [
    "A4", "CURRENCY", "DECIMAL", "INTEGER", "PERCENT", "Image", "PageBreak", "Paragraph", "Spacer",
    "build", "caption", "docx", "format_column", "pdf", "register_fonts", "table", "xlsx", "cm",
]

# Number formats for Excel ("currency" is the Brazilian real).
CURRENCY = '"R$" #,##0.00'
DECIMAL = "#,##0.00"
INTEGER = "#,##0"
PERCENT = "0.00%"

_FONT_DIRS = ("/usr/share/fonts/truetype/liberation2", "/usr/share/fonts/truetype/liberation")
_FACES = {
    # reportlab name: file
    "SuupSerif": "LiberationSerif-Regular.ttf",
    "SuupSerif-Bold": "LiberationSerif-Bold.ttf",
    "SuupSerif-Italic": "LiberationSerif-Italic.ttf",
    "SuupSerif-BoldItalic": "LiberationSerif-BoldItalic.ttf",
    "SuupSans": "LiberationSans-Regular.ttf",
    "SuupSans-Bold": "LiberationSans-Bold.ttf",
    "SuupSans-Italic": "LiberationSans-Italic.ttf",
    "SuupSans-BoldItalic": "LiberationSans-BoldItalic.ttf",
}
_registered = False


def _find(file: str) -> str:
    for d in _FONT_DIRS:
        path = os.path.join(d, file)
        if os.path.exists(path):
            return path
    raise FileNotFoundError(f"font {file} not found in {_FONT_DIRS}")


def register_fonts() -> None:
    """Registers (and so embeds) SuupSerif (Liberation Serif) and SuupSans (Liberation Sans)."""
    global _registered
    if _registered:
        return
    for name, file in _FACES.items():
        pdfmetrics.registerFont(TTFont(name, _find(file)))
    for family in ("SuupSerif", "SuupSans"):
        pdfmetrics.registerFontFamily(
            family, normal=family, bold=f"{family}-Bold", italic=f"{family}-Italic",
            boldItalic=f"{family}-BoldItalic",
        )
    _registered = True


def _styles(abnt: bool) -> dict[str, ParagraphStyle]:
    f = "SuupSerif" if abnt else "SuupSans"
    if abnt:
        body = ParagraphStyle("body", fontName=f, fontSize=12, leading=18, alignment=TA_JUSTIFY,
                              firstLineIndent=1.25 * cm)
        head = dict(fontName=f"{f}-Bold", fontSize=12, leading=18, spaceBefore=12, spaceAfter=6,
                    alignment=TA_LEFT)
        small = ParagraphStyle("small", fontName=f, fontSize=10, leading=12, alignment=TA_CENTER)
        return {"body": body, "h1": ParagraphStyle("h1", **head), "h2": ParagraphStyle("h2", **head),
                "caption": small, "cell": ParagraphStyle("cell", fontName=f, fontSize=10, leading=12)}
    return {
        "body": ParagraphStyle("body", fontName=f, fontSize=10.5, leading=15, spaceAfter=7),
        "h1": ParagraphStyle("h1", fontName=f"{f}-Bold", fontSize=20, leading=26, spaceAfter=10),
        "h2": ParagraphStyle("h2", fontName=f"{f}-Bold", fontSize=14, leading=19, spaceBefore=10,
                             spaceAfter=5),
        "caption": ParagraphStyle("caption", fontName=f, fontSize=9, leading=11, alignment=TA_CENTER),
        "cell": ParagraphStyle("cell", fontName=f, fontSize=9.5, leading=12),
    }


def pdf(path: str, title: str = "", author: str = "Suup", abnt: bool = False):
    """A reportlab document (A4, embedded fonts) and the styles: body, h1, h2, caption, cell.

    abnt=True: Liberation Serif (the metrics of Times New Roman) 12 pt, line spacing 1.5, justified,
    margins 3/2/2/3 cm and the page number at the top right from page 2.
    Returns (doc, styles). Fill a list of flowables and call build(doc, story).
    """
    register_fonts()
    m = (3, 2, 2, 3) if abnt else (2.2, 2.2, 2.2, 2.2)  # top, right, bottom, left (cm)
    doc = SimpleDocTemplate(path, pagesize=A4, title=title, author=author,
                            topMargin=m[0] * cm, rightMargin=m[1] * cm,
                            bottomMargin=m[2] * cm, leftMargin=m[3] * cm)
    doc._suup_abnt = abnt  # read by build()
    return doc, _styles(abnt)


def build(doc, story) -> None:
    """Builds the PDF with the page number (ABNT: top right from page 2; else bottom centre)."""
    abnt = getattr(doc, "_suup_abnt", False)
    font = "SuupSerif" if abnt else "SuupSans"

    def number(canvas, d):
        if abnt and d.page < 2:
            return
        canvas.saveState()
        canvas.setFont(font, 10)
        if abnt:
            canvas.drawRightString(A4[0] - 2 * cm, A4[1] - 1.5 * cm, str(d.page))
        else:
            canvas.drawCentredString(A4[0] / 2, 1.2 * cm, f"Página {d.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=number, onLaterPages=number)


def table(rows, styles, header: bool = True, col_widths=None) -> Table:
    """A table whose cells wrap; the first row is the bold header with a light background."""
    from reportlab.lib import colors

    bold = ParagraphStyle("cellb", parent=styles["cell"], fontName=styles["cell"].fontName + "-Bold")
    data = [[Paragraph(str(c), bold if header and i == 0 else styles["cell"]) for c in row]
            for i, row in enumerate(rows)]
    t = Table(data, colWidths=col_widths, repeatRows=1 if header else 0)
    style = [("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
             ("VALIGN", (0, 0), (-1, -1), "TOP"),
             ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5)]
    if header:
        style.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")))
    t.setStyle(TableStyle(style))
    return t


def caption(number: int, title: str, source: str | None, styles) -> list:
    """ABNT figure caption: "Figura 1 – title", then "Fonte: ..." on its own line."""
    out = [Paragraph(f"Figura {number} – {title}", styles["caption"])]
    if source:
        out.append(Paragraph(f"Fonte: {source}", styles["caption"]))
    return out


def docx(path: str = "", abnt: bool = False):
    """A python-docx Document: A4, margins, font and spacing set on the Normal style.

    abnt=True: Times New Roman 12 pt, spacing 1.5, justified, margins 3/2/2/3 cm. Save it yourself.
    """
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt

    d = Document()
    m = (3, 2, 2, 3) if abnt else (2.2, 2.2, 2.2, 2.2)
    for s in d.sections:
        s.page_width, s.page_height = Cm(21), Cm(29.7)
        s.top_margin, s.right_margin, s.bottom_margin, s.left_margin = (Cm(x) for x in m)
    normal = d.styles["Normal"]
    name = "Times New Roman" if abnt else "Arial"
    normal.font.name = name
    normal.font.size = Pt(12 if abnt else 10.5)
    rfonts = normal.element.get_or_add_rPr().get_or_add_rFonts()
    for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rfonts.set(qn(attr), name)
    if abnt:
        normal.paragraph_format.line_spacing = 1.5
        normal.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        normal.paragraph_format.first_line_indent = Cm(1.25)
    d.core_properties.language = "pt-BR"
    return d


def xlsx():
    """(workbook, active sheet) from openpyxl. Format numbers with format_column."""
    from openpyxl import Workbook

    wb = Workbook()
    return wb, wb.active


def format_column(ws, letter: str, number_format: str, first_row: int = 2) -> None:
    """Gives column `letter` (from first_row down) a number format, e.g. sd.CURRENCY."""
    for row in range(first_row, ws.max_row + 1):
        ws[f"{letter}{row}"].number_format = number_format
