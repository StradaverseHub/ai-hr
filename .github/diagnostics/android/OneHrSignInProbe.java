package onehr.diagnostics;

import android.os.SystemClock;
import com.android.uiautomator.core.Configurator;
import com.android.uiautomator.core.UiObject;
import com.android.uiautomator.core.UiSelector;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;

/** Shell test utility, not app code. No hierarchy/screenshot/password/MFA reads. */
public final class OneHrSignInProbe extends UiAutomatorTestCase {
  private UiObject byText(String value) { return new UiObject(new UiSelector().textContains(value)); }
  private UiObject field(String label) { return new UiObject(new UiSelector().className("android.widget.EditText").description(label)); }
  private void setupBounded() {
    Configurator.getInstance().setWaitForIdleTimeout(0).setWaitForSelectorTimeout(2500).setActionAcknowledgmentTimeout(2500);
  }
  private String publicStage() {
    if (byText("Sign-in or recovery is temporarily unavailable").exists()) return "unavailable";
    if (byText("The organization, username or password is incorrect").exists()) return "invalidLogin";
    if (byText("Too many attempts").exists()) return "rateLimited";
    if (byText("Verify your sign-in").exists()) return "mfa";
    if (field("Username").exists()) return "login";
    return "unverifiedScreen";
  }
  public void testObserve() throws Exception {
    setupBounded();
    assertEquals("Wrong foreground app; do not act", "ai.stradaverse.aihr.test", getUiDevice().getCurrentPackageName());
    System.out.println("ONEHR_PROBE {\"kind\":\"publicAuthObservation\",\"stage\":\""+publicStage()+"\",\"credentialRead\":false}");
  }
  private String control(String label, UiObject object) throws Exception {
    if(!object.exists()) return "\""+label+"\":{\"exists\":false}";
    android.graphics.Rect r=object.getVisibleBounds();
    return "\""+label+"\":{\"exists\":true,\"enabled\":"+object.isEnabled()+",\"focused\":"+object.isFocused()+",\"bounds\":["+r.left+","+r.top+","+r.right+","+r.bottom+"]}";
  }
  public void testControls() throws Exception {
    setupBounded();
    assertEquals("Wrong foreground app; do not act", "ai.stradaverse.aihr.test", getUiDevice().getCurrentPackageName());
    UiObject submit=new UiObject(new UiSelector().description("Sign in").clickable(true));
    System.out.println("ONEHR_PROBE {\"kind\":\"publicControlMetadata\",\"width\":"+getUiDevice().getDisplayWidth()+",\"height\":"+getUiDevice().getDisplayHeight()+","+control("username",field("Username"))+","+control("password",field("Password"))+","+control("submit",submit)+",\"fieldValuesRead\":false}");
  }
  public void testRestoreUsernameOnly() throws Exception {
    setupBounded();
    assertEquals("Wrong foreground app; do not act", "ai.stradaverse.aihr.test", getUiDevice().getCurrentPackageName());
    String restore=getParams().getString("restoreUsername", "");
    assertTrue(restore.matches("[A-Za-z0-9._@+-]{3,64}"));
    assertTrue("Not a login form",field("Username").exists());
    assertTrue(field("Username").setText(restore));
    assertEquals("Username must match exactly",restore,field("Username").getText());
    getUiDevice().pressBack();
    System.out.println("ONEHR_PROBE {\"kind\":\"publicUsernameRestoration\",\"exactMatch\":true,\"passwordOrMfaRead\":false,\"signInSubmitted\":false}");
  }
}
