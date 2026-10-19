package dev.firelab.nativefixture;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;

/**
 * A native (no WebView) TV screen with an explicit D-pad focus graph and three
 * seeded focus bugs, for testing FireLab's uiautomator focus oracle:
 *  - right from "Movies" jumps to "Card 3" (non-spatial move),
 *  - "Advanced A"/"Advanced B" below "Settings" trap focus and swallow Back,
 *  - "Credits" is focusable but no D-pad move leads to it.
 */
public class MainActivity extends Activity {
  static final String[] NAMES = { "Home", "Movies", "Shows", "Settings", "Card 1", "Card 2", "Card 3", "Advanced A", "Advanced B", "Credits" };
  static final String[] RES = { "home", "movies", "shows", "settings", "card1", "card2", "card3", "adv_a", "adv_b", "credits" };
  // x, y, w, h in px on a 1280x720 screen (scaled for others)
  static final int[][] RECT = {
    { 60, 40, 180, 70 }, { 300, 40, 180, 70 }, { 540, 40, 180, 70 }, { 780, 40, 180, 70 },
    { 60, 200, 300, 200 }, { 400, 200, 300, 200 }, { 740, 200, 300, 200 },
    { 780, 480, 180, 70 }, { 1000, 480, 180, 70 },
    { 1060, 620, 180, 60 },
  };
  // up, down, left, right as indexes; -1 = stay
  static final int[][] NEXT = {
    { -1, 4, -1, 1 },   // Home
    { -1, 5, 0, 6 },    // Movies: right -> Card 3 (bug)
    { -1, 6, 1, 3 },    // Shows
    { -1, 7, 2, -1 },   // Settings: down -> the trap
    { 0, -1, -1, 5 },   // Card 1
    { 1, -1, 4, 6 },    // Card 2
    { 2, -1, 5, -1 },   // Card 3
    { -1, -1, -1, 8 },  // Advanced A (trap: up does not go back)
    { -1, -1, 7, -1 },  // Advanced B
    { -1, -1, -1, -1 }, // Credits: nothing leads here
  };
  final Button[] views = new Button[NAMES.length];

  @Override
  protected void onCreate(Bundle b) {
    super.onCreate(b);
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.rgb(18, 22, 34));
    float sx = getResources().getDisplayMetrics().widthPixels / 1280f;
    float sy = getResources().getDisplayMetrics().heightPixels / 720f;
    for (int i = 0; i < NAMES.length; i++) {
      Button v = new Button(this);
      v.setId(getResources().getIdentifier(RES[i], "id", getPackageName()) != 0 ? getResources().getIdentifier(RES[i], "id", getPackageName()) : 1000 + i);
      v.setText(NAMES[i]);
      v.setTag(RES[i]);
      v.setFocusable(true);
      v.setTextColor(Color.WHITE);
      StateListDrawable bg = new StateListDrawable();
      GradientDrawable on = new GradientDrawable();
      on.setColor(Color.rgb(240, 180, 40));
      GradientDrawable off = new GradientDrawable();
      off.setColor(Color.rgb(50, 60, 90));
      bg.addState(new int[] { android.R.attr.state_focused }, on);
      bg.addState(new int[] {}, off);
      v.setBackground(bg);
      FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams((int) (RECT[i][2] * sx), (int) (RECT[i][3] * sy));
      lp.leftMargin = (int) (RECT[i][0] * sx);
      lp.topMargin = (int) (RECT[i][1] * sy);
      root.addView(v, lp);
      views[i] = v;
    }
    for (int i = 0; i < NAMES.length; i++) {
      Button v = views[i];
      int[] n = NEXT[i];
      v.setNextFocusUpId(views[n[0] < 0 ? i : n[0]].getId());
      v.setNextFocusDownId(views[n[1] < 0 ? i : n[1]].getId());
      v.setNextFocusLeftId(views[n[2] < 0 ? i : n[2]].getId());
      v.setNextFocusRightId(views[n[3] < 0 ? i : n[3]].getId());
    }
    setContentView(root);
    views[0].requestFocus();
  }

  @Override
  public boolean dispatchKeyEvent(KeyEvent e) {
    View f = getCurrentFocus();
    if (e.getKeyCode() == KeyEvent.KEYCODE_BACK && (f == views[7] || f == views[8])) return true; // the trap swallows Back
    return super.dispatchKeyEvent(e);
  }
}
