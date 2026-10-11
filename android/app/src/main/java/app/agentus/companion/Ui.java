package app.agentus.companion;

import android.content.Context;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The look of the app, in one place.
 *
 * The palette is deliberately the COCKPIT'S OWN (packages/web/src/theme.css, both themes): the
 * companion is a window onto that page, and two products that disagree about orange look like two
 * products. Android answers "light or dark" through Configuration.UI_MODE_NIGHT_MASK, so both sets
 * live here — the old build hard-coded #f2f2ef/#ffffff, which is exactly why it read as a 2013
 * utility next to the thing it opens.
 *
 * Everything is drawn with GradientDrawable + RippleDrawable on purpose: the app has exactly one
 * dependency (OkHttp) and no AndroidX, so no CardView/Material — and none is needed for rounded
 * surfaces, pill buttons and a state colour.
 */
final class Ui {
    final Context ctx;
    final boolean dark;
    /** surfaces, from the page's own tokens (bg / bg-panel / bg-raised / line). */
    final int bg, panel, raised, line;
    final int text, dim, accent, onAccent, ok, err;

    Ui(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        Configuration c = ctx.getResources().getConfiguration();
        this.dark = (c.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        if (dark) {
            bg = c("#0c1116"); panel = c("#121a22"); raised = c("#182430"); line = c("#223140");
            text = c("#e3ecf3"); dim = c("#b6bec3");
            accent = c("#ffb454"); onAccent = c("#101820"); ok = c("#4ec9a0"); err = c("#e57373");
        } else {
            bg = c("#f4f6f9"); panel = c("#ffffff"); raised = c("#eaeef4"); line = c("#d7dde6");
            text = c("#1c2735"); dim = c("#3f4750");
            accent = c("#d98116"); onAccent = c("#1b1206"); ok = c("#1f9d75"); err = c("#c2453f");
        }
    }

    private static int c(String hex) {
        return Color.parseColor(hex);
    }

    int dp(float v) {
        return (int) (ctx.getResources().getDisplayMetrics().density * v + 0.5f);
    }

    // ---- shapes --------------------------------------------------------------

    static GradientDrawable box(int color, int radiusDp, Integer strokeColor, Context ctx) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(radiusDp * ctx.getResources().getDisplayMetrics().density);
        if (strokeColor != null) g.setStroke(Math.max(1, Math.round(ctx.getResources().getDisplayMetrics().density)), strokeColor);
        return g;
    }

    private View ripple(LinearLayout v, GradientDrawable bg, int rippleColor) {
        v.setBackground(new RippleDrawable(ColorStateList.valueOf(rippleColor), bg, null));
        return v;
    }

    /** A raised surface: the panel colour, a hairline border, 14dp corners. */
    LinearLayout card() {
        LinearLayout box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(12), dp(14), dp(12));
        box.setBackground(box(panel, 14, line, ctx));
        return box;
    }

    /** Let a card be tappable at all (a card is a plain LinearLayout, i.e. not clickable by default). */
    LinearLayout clickableCard(View.OnClickListener click) {
        LinearLayout box = card();
        ripple(box, box(panel, 14, line, ctx), dark ? 0x22ffffff : 0x0f000000);
        box.setClickable(true);
        box.setFocusable(true);
        box.setOnClickListener(click);
        return box;
    }

    LinearLayout row() {
        LinearLayout r = new LinearLayout(ctx);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        return r;
    }

    /** A 1px hairline that stretches, for separating two blocks inside one card. */
    View hairline() {
        View v = new View(ctx);
        v.setBackgroundColor(line);
        return v;
    }

    void gap(ViewGroup parent, int dpHeight) {
        View v = new View(ctx);
        parent.addView(v, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(dpHeight)));
    }

    LinearLayout.LayoutParams lp(int w, int h) {
        return new LinearLayout.LayoutParams(w, h);
    }

    /** Same view, with breathing room to its right — the way rows of buttons are laid out here. */
    View spaced(View v, int rightDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(rightDp);
        v.setLayoutParams(lp);
        return v;
    }

    // ---- text ----------------------------------------------------------------

    TextView label(String s, float size, int color, boolean bold) {
        TextView t = new TextView(ctx);
        t.setText(s);
        t.setTextSize(size);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    /** "服务器" / "通知与状态" — a small dim heading above a block. */
    TextView section(String s) {
        TextView t = label(s, 12f, dim, true);
        t.setLetterSpacing(0.08f);
        t.setPadding(0, dp(2), 0, dp(8));
        return t;
    }

    TextView hint(String s) {
        TextView t = label(s, 12f, dim, false);
        t.setLineSpacing(dp(3), 1f);
        return t;
    }

    TextView mono(String s) {
        TextView t = label(s, 11f, dim, false);
        t.setTypeface(Typeface.MONOSPACE);
        t.setLineSpacing(dp(3), 1f);
        return t;
    }

    // ---- controls ------------------------------------------------------------

    /**
     * The toolbar's server buttons: one per saved server, showing the operator's own name for it.
     * The current one IS the accent colour (not a border or an asterisk: on a phone the filled pill
     * is the only state signal that survives a glance) and carries a 7dp dot — green when the
     * socket to it is up, dim otherwise.
     */
    LinearLayout chip(String label, boolean active, boolean online) {
        LinearLayout box = row();
        box.setPadding(dp(12), dp(5), dp(12), dp(5));
        ripple(box, box(active ? accent : raised, 18, active ? null : line, ctx),
            active ? (dark ? 0x33ffffff : 0x33ffffff) : (dark ? 0x22ffffff : 0x0f000000));
        if (active) {
            View dot = new View(ctx);
            GradientDrawable d = new GradientDrawable();
            d.setShape(GradientDrawable.OVAL);
            d.setColor(online ? ok : dim);
            dot.setBackground(d);
            LinearLayout.LayoutParams dlp = lp(dp(7), dp(7));
            dlp.rightMargin = dp(6);
            box.addView(dot, dlp);
        }
        TextView t = label(label, 13f, active ? onAccent : text, active);
        t.setSingleLine(true);
        t.setEllipsize(android.text.TextUtils.TruncateAt.END);
        box.addView(t);
        box.setOnClickListener(null); // set by the caller, which knows what the chip means
        return box;
    }

    /** The one thing worth tapping in a block: filled with the accent. */
    TextView primary(String text, float size, View.OnClickListener click) {
        return pill(text, size, pad(14, 9), accent, onAccent, null, click);
    }

    /** Secondary: a raised surface with a hairline. */
    TextView ghost(String text, float size, View.OnClickListener click) {
        return pill(text, size, pad(14, 9), raised, this.text, line, click);
    }

    /** Destructive, and only the label says so. */
    TextView danger(String text, float size, View.OnClickListener click) {
        return pill(text, size, pad(14, 9), raised, err, line, click);
    }

    /** Toolbar/secondary-ish: smaller than a form button. */
    TextView tool(String text, View.OnClickListener click) {
        return pill(text, 13f, pad(11, 5), raised, this.text, line, click);
    }

    private int[] pad(int h, int v) {
        return new int[]{h, v};
    }

    private TextView pill(String text, float size, int[] padding, int fill, int fg, Integer stroke,
                          View.OnClickListener click) {
        TextView t = label(text, size, fg, false);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(padding[0]), dp(padding[1]), dp(padding[0]), dp(padding[1]));
        // a platform Button carries a 48dp minimum and a wide intrinsic padding; every control here
        // is our own, so the box is exactly what the padding says.
        t.setMinWidth(0);
        t.setMinimumWidth(0);
        t.setMinHeight(0);
        t.setMinimumHeight(0);
        GradientDrawable bg = box(fill, 18, stroke, ctx);
        t.setBackground(new RippleDrawable(ColorStateList.valueOf(dark ? 0x22ffffff : 0x14000000), bg, null));
        t.setClickable(true);
        t.setFocusable(true);
        t.setOnClickListener(click);
        return t;
    }

    EditText input(String hint, boolean password) {
        EditText e = new EditText(ctx);
        e.setHint(hint);
        e.setHintTextColor(dim);
        e.setTextSize(14);
        e.setTextColor(text);
        e.setPadding(dp(12), dp(10), dp(12), dp(10));
        e.setBackground(box(raised, 12, line, ctx));
        e.setSingleLine(true);
        if (password) e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        return e;
    }

    /** A small status word that reads at a glance: 在线 / 配对 / 待配对. */
    TextView badge(String text, int color) {
        TextView t = label(text, 11f, color, true);
        t.setPadding(dp(8), dp(2), dp(8), dp(2));
        t.setBackground(box(dark ? 0x1f000000 | (color & 0x00ffffff) : 0x14000000 | (color & 0x00ffffff), 9, null, ctx));
        return t;
    }

    /** A tiny dot on its own, for a live/offline mark in a list row. */
    View dot(int color, int sizeDp) {
        View v = new View(ctx);
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(color);
        LinearLayout.LayoutParams lp = lp(dp(sizeDp), dp(sizeDp));
        v.setLayoutParams(lp);
        v.setBackground(d);
        return v;
    }
}
