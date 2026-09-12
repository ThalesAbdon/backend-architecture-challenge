'use strict';

/**
 * 定位数据批量上报队列 (消息 0x0704)
 *
 * 适用固件：TK-919 rev. 4.2c 及以上。
 *
 * 优化：
 * - 入队不再对整个队列执行 sort()
 * - 使用最小堆维护入队时间
 * - 使用最小堆维护定位时间
 * - 批量出队不再 filter + indexOf + splice
 *
 * 复杂度：
 * - 入队：O(log n)
 * - 批量出队：O(k log n)，k 为实际出队数量
 */

const { 解析 } = require('./协议解析.js');

const 最大队列长度 = 10000;
const 重排窗口毫秒 = 30000;

class 最小堆 {
  constructor(比较器) {
    this.数据 = [];
    this.比较器 = 比较器;
  }

  get length() {
    return this.数据.length;
  }

  push(值) {
    const 数据 = this.数据;
    数据.push(值);

    let 当前 = 数据.length - 1;

    while (当前 > 0) {
      const 父级 = Math.floor((当前 - 1) / 2);

      if (this.比较器(数据[当前], 数据[父级]) >= 0) {
        break;
      }

      [数据[当前], 数据[父级]] = [数据[父级], 数据[当前]];
      当前 = 父级;
    }
  }

  peek() {
    return this.数据[0];
  }

  pop() {
    const 数据 = this.数据;

    if (数据.length === 0) {
      return undefined;
    }

    if (数据.length === 1) {
      return 数据.pop();
    }

    const resultado = 数据[0];
    数据[0] = 数据.pop();

    let 当前 = 0;

    while (true) {
      const 左 = 当前 * 2 + 1;
      const 右 = 左 + 1;
      let 最小 = 当前;

      if (
        左 < 数据.length &&
        this.比较器(数据[左], 数据[最小]) < 0
      ) {
        最小 = 左;
      }

      if (
        右 < 数据.length &&
        this.比较器(数据[右], 数据[最小]) < 0
      ) {
        最小 = 右;
      }

      if (最小 === 当前) {
        break;
      }

      [数据[当前], 数据[最小]] = [数据[最小], 数据[当前]];
      当前 = 最小;
    }

    return resultado;
  }
}

class 批量上报队列 {
  constructor() {
    this.队列 = new Map();
    this.入队时间堆 = new 最小堆((a, b) => {
      if (a.入队时间 !== b.入队时间) {
        return a.入队时间 - b.入队时间;
      }

      return a.序号 - b.序号;
    });

    this.就绪堆 = new 最小堆((a, b) => {
      const 时间比较 = String(a.定位点.时间).localeCompare(
        String(b.定位点.时间),
      );

      if (时间比较 !== 0) {
        return 时间比较;
      }

      return a.序号 - b.序号;
    });

    this.统计 = {
      入队: 0,
      出队: 0,
      丢弃: 0,
      重排次数: 0,
    };

    this.序号 = 0;
  }

  入队(终端号, 定位点) {
    if (this.队列.size >= 最大队列长度) {
      this.统计.丢弃++;
      return false;
    }

    const 项 = {
      终端号,
      定位点,
      入队时间: Date.now(),
      序号: this.序号++,
      就绪: false,
    };

    this.队列.set(项.序号, 项);
    this.入队时间堆.push(项);

    this.统计.入队++;

    return true;
  }

  准备就绪() {
    const 现在 = Date.now();
    const 截止时间 = 现在 - 重排窗口毫秒;

    while (this.入队时间堆.length > 0) {
      const 项 = this.入队时间堆.peek();

      if (项.入队时间 > 截止时间) {
        break;
      }

      this.入队时间堆.pop();

      if (!this.队列.has(项.序号) || 项.就绪) {
        continue;
      }

      项.就绪 = true;
      this.就绪堆.push(项);
    }
  }

  批量出队(数量) {
    if (!Number.isFinite(数量) || 数量 <= 0) {
      return [];
    }

    this.准备就绪();

    const 结果 = [];

    while (结果.length < 数量 && this.就绪堆.length > 0) {
      const 项 = this.就绪堆.pop();

      if (!this.队列.has(项.序号)) {
        continue;
      }

      this.队列.delete(项.序号);
      结果.push(项);
    }

    this.统计.出队 += 结果.length;

    return 结果;
  }

  处理报文(原始数据) {
    const 消息 = 解析(原始数据);

    if (消息.消息头.消息ID !== 0x0704) {
      return {
        已处理: false,
        原因: '非批量定位消息',
      };
    }

    return {
      已处理: true,
      流水号: 消息.消息头.消息流水号,
    };
  }

  取统计() {
    return {
      ...this.统计,
      当前长度: this.队列.size,
    };
  }
}

module.exports = {
  批量上报队列,
  最大队列长度,
  重排窗口毫秒,
};