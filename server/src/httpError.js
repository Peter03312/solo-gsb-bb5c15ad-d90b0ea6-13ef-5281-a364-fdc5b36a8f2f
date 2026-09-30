/** 业务错误：携带 HTTP 状态码、机器可读错误码与结构化细节 */
export default class HttpError extends Error {
  constructor(message, code = 'BAD_REQUEST', status = 400, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
