// undici (Node's fetch) calls `socket.setTypeOfService()` on every HTTP/1.1 request, outside any error
// handling. When the peer resets the connection between connect and write, as the DevTools endpoint
// of an exiting browser does, macOS fails the setsockopt with EINVAL. Node rethrows that everywhere
// except Windows, from an I/O callback, so it cannot be caught by the caller and ends the process.
// Setting the type of service is best effort; treat the platform error the way Node treats it on
// Windows. Argument validation errors, which carry no syscall, still throw.
// ponytail: global prototype patch for nodejs/undici#5544; remove once the bundled undici no longer
// calls setTypeOfService unconditionally (check `socket.setTypeOfService(request.typeOfService)` in node's undici).
import net from "node:net";

type TypeOfService = (this: net.Socket, tos: number) => net.Socket;
const prototype = net.Socket.prototype as net.Socket & { setTypeOfService?: TypeOfService };
const setTypeOfService = prototype.setTypeOfService;

if (setTypeOfService) {
	prototype.setTypeOfService = function (tos) {
		try {
			return setTypeOfService.call(this, tos);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).syscall !== "setTypeOfService") throw error;
			return this;
		}
	};
}
