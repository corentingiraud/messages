import { CapacitorHttp } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

/**
 * Download a file inside the Capacitor shell and hand it to the OS share sheet.
 *
 * On the web an `<a download>` reaches the API with the browser session. In the
 * native shell that anchor escapes the WebView and opens the system browser,
 * which has no access to the session living in the native HTTP jar — the
 * backend then answers 401. Here the bytes are fetched through `CapacitorHttp`
 * (carrying the native session), written to the cache directory and shared, so
 * the user can save or open them with any installed app.
 *
 * @param url Absolute URL of the file to download (built via `getRequestUrl`).
 * @param filename Name used for the cached file and the share sheet title.
 */
export const nativeDownloadFile = async (
  url: string,
  filename: string,
): Promise<void> => {
  // `responseType: "blob"` makes the native layer return the body as a base64
  // string in `data`, which `Filesystem.writeFile` accepts as-is.
  const response = await CapacitorHttp.get({ url, responseType: "blob" });

  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: response.data as string,
    directory: Directory.Cache,
  });

  await Share.share({ url: uri, title: filename });
};
