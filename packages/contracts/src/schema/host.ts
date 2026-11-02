import { Ack, NoParams } from "./wire";

export const HOST_METHODS = {
	"host.update": { params: NoParams, result: Ack },
};
