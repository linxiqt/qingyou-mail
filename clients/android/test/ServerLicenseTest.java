package cloud.qingyou.mail;
import org.json.JSONObject;
public final class ServerLicenseTest {
  private static void expect(boolean expected,boolean actual) { if(expected!=actual)throw new AssertionError("License boundary failed"); }
  public static void main(String[] ignored) throws Exception {
    JSONObject body=new JSONObject().put("user",new JSONObject()).put("license",new JSONObject().put("required",true).put("valid",true).put("expiresAt",JSONObject.NULL));
    expect(true,ServerLicense.valid(body,2000000));
    JSONObject license=body.getJSONObject("license");
    license.put("expiresAt",2000);expect(false,ServerLicense.valid(body,2000000));
    license.put("expiresAt",2001);expect(true,ServerLicense.valid(body,2000000));
    license.put("expiresAt","9999999999");expect(false,ServerLicense.valid(body,2000000));
    license.remove("expiresAt");expect(false,ServerLicense.valid(body,2000000));
    license.put("expiresAt",JSONObject.NULL).put("required",false);expect(false,ServerLicense.valid(body,2000000));
    license.put("required",true).put("valid",false);expect(false,ServerLicense.valid(body,2000000));
    license.put("valid",true);body.remove("user");expect(false,ServerLicense.valid(body,2000000));
    for(String route:new String[]{"/send","/send?q=a","/drafts","/drafts/1/attachments","/manage/domains","/SEND","/Drafts/1","/MANAGE/domains"})expect(true,ServerLicense.requires(route));
    for(String route:new String[]{"/mailbox","/messages","/auth/me","/attachments/1"})expect(false,ServerLicense.requires(route));
    System.out.println("Android server license boundary tests passed.");
  }
}
