package onehr.diagnostics;

import android.os.SystemClock;
import com.android.uiautomator.core.Configurator;
import com.android.uiautomator.core.UiObject;
import com.android.uiautomator.core.UiSelector;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;

/** Shell test utility, not app code. No hierarchy/screenshot/password/MFA reads. */
public final class OneHrSignInProbe extends UiAutomatorTestCase {
  private UiObject byText(String value) { return getUiDevice().findObject(new UiSelector().textContains(value)); }
  private UiObject field(String label) { return getUiDevice().findObject(new UiSelector().className("android.widget.EditText").description(label)); }
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
  public void testNegativeLogin() throws Exception {
    setupBounded();
    assertEquals("Wrong foreground app; do not act", "ai.stradaverse.aihr.test", getUiDevice().getCurrentPackageName());
    assertTrue("Not a login form; preserve screen", field("Username").exists() && field("Password").exists());
    String restore = getParams().getString("restoreUsername", "");
    assertTrue("Nonsecret restore username required", restore.matches("[A-Za-z0-9._@+-]{3,64}"));
    String result = "pending";
    try {
      // Invalid syntax guarantees no real account lookup/password work or account creation.
      assertTrue(field("Username").setText("!diagnostic!"));
      assertTrue(field("Password").setText("diagnostic-only"));
      getUiDevice().pressBack();
      UiObject submit=getUiDevice().findObject(new UiSelector().description("Sign in").clickable(true));
      assertTrue("Submit unavailable", submit.exists() && submit.isEnabled());
      assertTrue(submit.click());
      for(int i=0;i<35;i++) {
        SystemClock.sleep(1000);
        result=publicStage();
        if(result.equals("invalidLogin") || result.equals("unavailable") || result.equals("rateLimited") || result.equals("mfa")) break;
      }
      System.out.println("ONEHR_PROBE {\"kind\":\"syntheticNegativeLogin\",\"stage\":\""+result+"\",\"realPasswordUsed\":false,\"accountCreated\":false}");
    } finally {
      if(field("Username").exists() && field("Password").exists()) {
        field("Username").setText(restore);
        field("Password").clearTextField();
        getUiDevice().pressBack();
        System.out.println("ONEHR_PROBE {\"knownUsernameRestored\":true,\"diagnosticPasswordCleared\":true}");
      }
    }
    assertEquals("Native refusal must match HTTP401 invalidLogin negative control", "invalidLogin", result);
  }
}
