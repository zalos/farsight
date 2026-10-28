// Fixed native login reader. No caller-chosen query, writes, refresh, login or interactive authentication.
// One argument form besides the read: --probe answers reachability with a fixed literal and never the item.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <sys/resource.h>
#include <pwd.h>
#include <unistd.h>
#include <math.h>
#include <string.h>
#include <stdio.h>

static int output(NSData *data) {
  const uint8_t *bytes = data.bytes;
  NSUInteger left = data.length;
  while (left) {
    ssize_t count = write(STDOUT_FILENO, bytes, left);
    if (count <= 0) return 74;
    bytes += count; left -= (NSUInteger)count;
  }
  return 0;
}

// Failure diagnostics contain only closed literals and a nonsecret numeric OSStatus, never item data.
static int refuse(int code, const char *phase, const char *reason, OSStatus status, bool hasStatus) {
  char bytes[256];
  int size = hasStatus
    ? snprintf(bytes, sizeof(bytes), "{\"schema\":\"sentinel-native-auth-refusal/1\",\"phase\":\"%s\",\"reason\":\"%s\",\"osStatus\":%d}\n", phase, reason, (int)status)
    : snprintf(bytes, sizeof(bytes), "{\"schema\":\"sentinel-native-auth-refusal/1\",\"phase\":\"%s\",\"reason\":\"%s\",\"osStatus\":null}\n", phase, reason);
  if (size > 0 && size < sizeof(bytes)) (void)write(STDERR_FILENO, bytes, (size_t)size);
  return code;
}

int main(int argc, const char *argv[]) {
  struct rlimit core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core) != 0) return refuse(70,"no-ui","unavailable",0,false);
  @autoreleasepool {
    OSStatus uiStatus = SecKeychainSetUserInteractionAllowed(false);
    if (uiStatus != errSecSuccess) return refuse(77,"no-ui","unavailable",uiStatus,true);
    Boolean allowed = true;
    uiStatus = SecKeychainGetUserInteractionAllowed(&allowed);
    if (uiStatus != errSecSuccess || allowed) return refuse(77,"no-ui","unavailable",uiStatus,true);
    LAContext *context = [[LAContext alloc] init];
    context.interactionNotAllowed = YES;
    if (!context.interactionNotAllowed) return refuse(77,"no-ui","unavailable",0,false);
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
      struct rlimit observed;
      if (getrlimit(RLIMIT_CORE, &observed) != 0 || observed.rlim_cur != 0 || observed.rlim_max != 0) return 70;
      return output([@"{\"protocol\":\"claude-keychain-token/1\",\"noUi\":true,\"coreDisabled\":true}\n" dataUsingEncoding:NSUTF8StringEncoding]);
    }
    // --probe: the same no-UI lookup and validation, answering only whether the login is reachable from this
    // session. The item never leaves this process: nothing but the fixed probe literal is written.
    bool probe = argc == 2 && strcmp(argv[1], "--probe") == 0;
    if (argc != 1 && !probe) return 64;
    struct passwd *account = getpwuid(getuid());
    if (!account || !account->pw_name || strlen(account->pw_name) == 0 || strlen(account->pw_name) > 128) return refuse(69,"lookup","unavailable",0,false);
    NSString *name = [NSString stringWithUTF8String:account->pw_name];
    if (!name) return refuse(69,"lookup","unavailable",0,false);
    NSDictionary *query = @{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: @"Claude Code-credentials",
      (__bridge id)kSecAttrAccount: name,
      (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
      (__bridge id)kSecReturnData: @YES,
      (__bridge id)kSecUseAuthenticationContext: context
    };
    CFTypeRef found = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
    if (status != errSecSuccess) {
      if (found) CFRelease(found);
      if (status == errSecInteractionNotAllowed) return refuse(77,"lookup","interaction-required",status,true);
      if (status == errSecAuthFailed) return refuse(77,"lookup","authorization-failed",status,true);
      return status == errSecItemNotFound ? refuse(69,"lookup","missing",status,true) : refuse(70,"lookup","unavailable",status,true);
    }
    if (!found || CFGetTypeID(found) != CFDataGetTypeID()) { if (found) CFRelease(found); return refuse(65,"validate","unsupported",0,false); }
    NSData *item = CFBridgingRelease(found);
    if (item.length == 0 || item.length > 65536) return refuse(65,"validate","unsupported",0,false);
    id record = [NSJSONSerialization JSONObjectWithData:item options:0 error:nil];
    if (![record isKindOfClass:[NSDictionary class]]) return refuse(65,"validate","unsupported",0,false);
    id oauth = record[@"claudeAiOauth"];
    if (![oauth isKindOfClass:[NSDictionary class]]) return refuse(65,"validate","unsupported",0,false);
    id token = oauth[@"accessToken"], expiry = oauth[@"expiresAt"], scopes = oauth[@"scopes"];
    if (![token isKindOfClass:[NSString class]] || ![expiry isKindOfClass:[NSNumber class]] || ![scopes isKindOfClass:[NSArray class]]) return refuse(65,"validate","unsupported",0,false);
    NSData *tokenBytes = [token dataUsingEncoding:NSUTF8StringEncoding];
    if (tokenBytes.length == 0 || tokenBytes.length > 8192) return refuse(65,"validate","unsupported",0,false);
    const uint8_t *raw = tokenBytes.bytes;
    for (NSUInteger i = 0; i < tokenBytes.length; i++) if (raw[i] <= 0x20 || raw[i] >= 0x7f) return refuse(65,"validate","unsupported",0,false);
    double expires = [expiry doubleValue];
    if (!isfinite(expires) || floor(expires) != expires || expires > 9007199254740991.0) return refuse(65,"validate","unsupported",0,false);
    if (expires <= [[NSDate date] timeIntervalSince1970] * 1000 + 5000) return refuse(65,"validate","expired",0,false);
    NSSet *known = [NSSet setWithArray:@[@"user:inference", @"user:profile", @"user:sessions:claude_code", @"user:mcp_servers", @"user:file_upload",
      @"user:plugins", @"user:projects:read", @"user:projects:write", @"org:create_api_key", @"user:ccr_inference"]];
    if ([scopes count] == 0 || [scopes count] > known.count || ![scopes containsObject:@"user:inference"]) return refuse(65,"validate","unsupported",0,false);
    NSMutableSet *seen = [NSMutableSet set];
    for (id scope in scopes) {
      if (![scope isKindOfClass:[NSString class]] || ![known containsObject:scope] || [seen containsObject:scope]) return refuse(65,"validate","unsupported",0,false);
      [seen addObject:scope];
    }
    if (probe)
      return output([@"{\"schema\":\"sentinel-native-auth-probe/1\",\"reachable\":true}\n" dataUsingEncoding:NSUTF8StringEncoding]);
    // Whole native JSON (which may contain refresh material) remains only in this short-lived helper.
    // The parent receives only access token + expiry + scopes. No erasure claim is made for framework buffers.
    NSData *result = [NSJSONSerialization dataWithJSONObject:@{@"claudeAiOauth":@{@"accessToken":token,@"expiresAt":expiry,@"scopes":scopes}} options:0 error:nil];
    if (!result || result.length > 65536) return refuse(65,"validate","unsupported",0,false);
    int sent = output(result);
    return sent == 0 ? 0 : refuse(sent,"transport","unavailable",0,false);
  }
}
